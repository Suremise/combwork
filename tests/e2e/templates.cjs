// Agent templates (#126, #286, #975): + Add ▾ → Templates ▸ → Save Template… in the session toolbar (a name; the workspace
// scope ticked; replacing asks), loading into another project from Templates ▸ (the warning lists who goes and who comes;
// refused while an agent runs and while a worktree agent has uncommitted work; HI-2109: a CLI it suggests that's off
// only changes which connection is offered, and the Connections section chooses them: Same for all, per role, per agent,
// in both themes), the layout, roles in the workflow, notes and pairs recreated (#1436: every agent in the project folder), the
// removed worktree kept, + Add ▾ → Add Agent from Template (a taken name numbered), with the mouse, the keyboard and the
// palette, and the toolbar's controls at narrow widths in both themes,
// every one reachable, in the order Panes | Tiles, the summary chip, pages, layouts, + Add ▾ (#292), with one page and two. #702: agent names unique across the
// workspace: Add Agent refuses another project's agent's name, offering one, and shows what hive/ in a branch means; a
// template's load shows each name in the template beside a box for the agent's new name: a name another project's
// agent has (or one used twice) is marked and Load template greyed out until it is changed; nothing is filled in. Agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
// Dev build only (#1580): it starts this checkout's Electron itself, and Tree is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build) (in beta, with uncommitted work, and in alpha as a template's
// source).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// Only its agents (HI-1910): its workflow, ticked by default, would open Version Control → Workflow after the load.
const agentsOnly = async (d) => {
  const box = d.locator('[data-workflow-apply]')
  if (await box.count()) await box.uncheck()
}
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
// A load's confirmation shows once the template's plan is read, with git checks of the agents it removes: the 12-agent
// template's took 8.8 and 10 s under load when it made worktrees, past HUNG_MS though nothing hung (#715). The longest a
// plan read may take: a bound for a hung one, never how long it should take.
const PLAN_HUNG_MS = 60000

const userData = path.join(lib.WORK, 'templates-profile')
const ws = path.join(lib.WORK, 'templates-ws')
const claudeHome = path.join(lib.WORK, 'templates-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47886), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1700, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const projectCfg = (p) => lib.projectConfig(userData, p) // with this user's view over it (HI-1749)
  const strip = page.locator('.session-toolbar')
  const dialog = page.locator('.dialog').last()
  const menuItems = async () => (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.split('\n')[0].trim())
  // A menu item by its label exactly (its detail line aside).
  const item = (label) => page.locator('.menu .menu-item').filter({ has: page.getByText(label, { exact: true }) }).first()
  // A menu its button opened, waited for and checked (#663): one that never opened throws instead of the next step failing.
  const menuOpen = async () => {
    if (!(await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS))) throw new Error(`the menu didn't open; the window: ${await page.locator('.project-header h1').innerText().catch(() => '?')}`)
  }
  // + Add ▾ → Templates ▸ (#975): Save Template…, a separator, then the templates to load.
  const templateMenu = async () => {
    await lib.addMenuRun(page, 'Templates')
    if (!(await lib.until(async () => (await menuItems()).includes('Save Template…'), HUNG_MS))) throw new Error(`Templates ▸ didn't open: ${JSON.stringify(await menuItems())}`)
  }
  const saveTemplate = async () => {
    await templateMenu()
    await item('Save Template…').click()
  }
  // A dialog that follows a click (a load's confirmation comes once the template's plan, git included, is read):
  // waited for as it shows, bounded only for a hung plan read (#663, #715). A slow one is logged with how long it took;
  // one that never came throws with what the window showed instead.
  const shown = async (d, what) => {
    const t = Date.now()
    const ok = await lib.until(() => d.isVisible(), PLAN_HUNG_MS)
    if (Date.now() - t > 2000) console.log(`  (${what} took ${Date.now() - t} ms)`)
    if (!ok) throw new Error(`${what} didn't show; the window: ${await page.locator('.project-header h1').innerText().catch(() => '?')}, dialogs ${JSON.stringify(await page.locator('.dialog').allInnerTexts())}, menu ${JSON.stringify(await menuItems())}`)
  }
  const select = async (name) => {
    await page.locator('.project-row', { hasText: name }).first().click()
    const shows = async () => page.locator('.project-header h1').innerText().catch(() => '')
    if (!(await lib.until(async () => (await shows()) === name, HUNG_MS))) throw new Error(`${name} wasn't selected; the window shows ${await shows()}`)
  }

  // --- alpha: Builder (role builder) and Reviewer, two columns. Save Template…, for the workspace.
  await select('alpha')
  await lib.addAgent(inv, alpha, { name: 'Builder', role: 'builder', model: 'opus' })
  await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  await inv('project:updateConfig', alpha, { layout: 'columns3' })
  await inv('workspace:refresh')
  // With none of the user's yet, Add Agent from Template lists Hive's own (#1436), their agents named from the
  // project's key (alpha's: AL-B1).
  await lib.addMenuRun(page, 'Add Agent from Template')
  check("Add Agent from Template with none saved yet lists Hive's own, named from the project's key", !!(await lib.until(async () => (await menuItems()).includes('AL-B1') && (await menuItems()).includes('AL-R6'), HUNG_MS)) && !(await menuItems()).some((n) => n.includes('{key}')), JSON.stringify(await menuItems()))
  // Escape closes the submenu, then + Add ▾'s own.
  await lib.until(async () => (await page.locator('.menu').count()) === 0 || void (await page.keyboard.press('Escape')), HUNG_MS)
  // …and following it works: + Add ▾ → Templates → Save Template…
  await saveTemplate()
  await shown(dialog, 'dialog')
  await dialog.locator('input.input').fill('Pair')
  await dialog.locator('input[type="checkbox"]').first().check()
  await page.screenshot({ path: path.join(lib.WORK, 'templates-1-save.png') })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const file = path.join(ws, '.combwork', 'templates', 'pair.json')
  check('Save Template… keeps the agents, roles and layout for the workspace', !!(await lib.until(async () => fs.existsSync(file), 5000)) && /"role": "builder"/.test(fs.readFileSync(file, 'utf8')) && /"layout": "columns3"/.test(fs.readFileSync(file, 'utf8')))
  check('without sessions, ids or paths', !/lastSessionId|"id"|templates-ws/.test(fs.readFileSync(file, 'utf8')))
  // The same name again: asks before replacing.
  await saveTemplate()
  await dialog.locator('input.input').fill('pair')
  await dialog.locator('input[type="checkbox"]').first().check()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const replace = page.locator('.dialog', { hasText: 'Replace the template?' })
  check('saving over a name asks first', !!(await lib.until(async () => (await replace.count()) === 1, 5000)))
  await replace.getByRole('button', { name: 'Replace' }).click()
  await lib.until(async () => JSON.parse(fs.readFileSync(file, 'utf8')).name === 'pair', 5000)
  check('…and replaces it', JSON.parse(fs.readFileSync(file, 'utf8')).name === 'pair')
  // alpha's agents renamed (names are unique across the workspace, #702), so pair's Builder and Reviewer are free in beta.
  for (const a of projectCfg(alpha).agents) await inv('agents:update', alpha, a.id, { name: `Alpha ${a.name.toLowerCase()}` })

  // --- beta: Old (running) and Tree (a worktree agent with uncommitted work). Loading is refused until both are dealt with.
  await select('beta')
  const old = await lib.addAgent(inv, beta, { name: 'Old' })
  const tree = await lib.addAgent(inv, beta, { name: 'Tree', location: 'new-worktree' })
  await inv('session:start', beta, { agentId: old.id })
  await lib.until(async () => (await live(beta, old.id))?.status === 'ready', 15000)
  fs.writeFileSync(path.join(tree.worktree.path, 'wip.txt'), 'uncommitted')
  await inv('workspace:refresh')
  const loadMenu = templateMenu
  await loadMenu()
  check('Templates ▸ lists the workspace template', (await menuItems()).includes('pair'), JSON.stringify(await menuItems()))
  const shape = await page.evaluate(() => [...document.querySelector('.menu').children].slice(0, 3).map((el) => el.className.split(' ')[0] + ':' + el.textContent.trim()))
  check("…after Save Template…, a separator and Hive's own (#1436)", shape[0] === 'menu-item:Save Template…' && shape[1] === 'menu-sep:' && shape[2] === "menu-header:Hive's templates", JSON.stringify(shape))
  // (Headers are upper-case by CSS.)
  const headers = (await page.locator('.menu .menu-header').allInnerTexts()).map((h) => h.toLowerCase())
  check("…Hive's own, then the workspace's", JSON.stringify(headers) === JSON.stringify(["hive's templates", 'workspace templates']), JSON.stringify(headers))
  await item('pair').click()
  const blocked = page.locator('.dialog', { hasText: "Can't load" })
  await shown(blocked, 'blocked')
  const why = await blocked.innerText()
  check('refused while Old runs and Tree has uncommitted work', /Old is running or starting: stop it first/.test(why) && /Tree has uncommitted work/.test(why), why)
  await page.screenshot({ path: path.join(lib.WORK, 'templates-2-blocked.png') })
  await blocked.getByRole('button', { name: 'OK' }).click()
  check('nothing changed', JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Old","Tree"]')

  // A CLI it suggests that's off (HI-2109): only a suggestion, so never a refusal (the agents still run and their work is
  // still there here: it's those that refuse it).
  fs.mkdirSync(path.join(ws, '.combwork', 'templates'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.combwork', 'templates', 'codex-pair.json'), JSON.stringify({ version: 2, name: 'Codex pair', savedAt: new Date().toISOString(), layout: 'auto', agents: [{ name: 'Coder', role: 'builder', provider: 'codex' }] }))
  await loadMenu()
  await item('Codex pair').click()
  await shown(blocked, 'blocked')
  const codexWhy = await blocked.innerText()
  check('a CLI it suggests that is off stops nothing: only the running agent and the work do', !/turned off|installed|Codex is/.test(codexWhy) && /Old is running/.test(codexWhy), codexWhy)
  await blocked.getByRole('button', { name: 'OK' }).click()

  // Stopped, and the work cleaned up: the warning lists who goes and who comes; loading replaces them.
  await inv('session:stop', beta, old.id)
  await lib.until(async () => !(await live(beta, old.id)), 10000)
  fs.rmSync(path.join(tree.worktree.path, 'wip.txt'))
  await inv('workspace:refresh')
  await loadMenu()
  await item('pair').click()
  const warn = page.locator('.dialog', { hasText: 'Load "pair"?' })
  await shown(warn, 'warn')
  // The plan as one table (#511, #1315): an agent's Change (replaced, new or removed, and what becomes of an old agent's
  // worktree), a row and its cells, by column: Agent, Change, Role, Connection (#1436: no Where; HI-2109: no model, effort
  // or mode of its own: the connection's).
  // (A removed agent's worktree note is across its row's settings; a replaced one's on the line under its row.)
  const removedLine = async (d, name) =>
    (
      await d
        .locator('.template-plan-table tbody')
        .evaluate((tb, n) => {
          const row = tb.querySelector(`tr[data-agent="${n}"]`)
          return [row?.querySelector('.template-plan-state')?.textContent, row?.querySelector('.template-plan-old')?.textContent, tb.querySelector(`tr[data-old-of="${n}"]`)?.textContent].filter(Boolean).join(' ')
        }, name)
        .catch(() => '')
    )
      .replace(/\s+/g, ' ')
      .trim()
  const stateOf = (d, name) => d.locator(`.template-plan-table tbody tr[data-agent="${name}"]`).getAttribute('data-state')
  const planRow = (d, name) => d.locator(`.template-plan-table tbody tr[data-agent="${name}"]`)
  // (An agent's name is a field to edit beside its name in the template, #702: the field's value, then the rest of the cell.)
  const cells = (d, name) =>
    planRow(d, name)
      .locator('td')
      .evaluateAll((tds) =>
        tds.map((td) => {
          const rest = [...td.childNodes].filter((n) => !(n instanceof Element && n.matches('.template-plan-from, input'))).map((n) => n.textContent).join(' ')
          return `${td.querySelector('input')?.value ?? ''} ${rest}`.replace(/\s+/g, ' ').trim()
        })
      )
  const created = (d) => d.locator('.template-plan-table tbody tr[data-agent]:not([data-state="removed"])').evaluateAll((rows) => rows.map((r) => r.dataset.agent))
  check('the warning lists who goes and who comes, in one table: the template\'s agents, then those removed', (await warn.locator('.template-plan-table tbody tr[data-state="removed"]').evaluateAll((l) => l.map((x) => x.dataset.agent))).join() === 'Old,Tree' && (await warn.locator('.template-plan-table tbody tr[data-agent]').evaluateAll((l) => l.map((x) => x.dataset.agent))).join() === 'Builder,Reviewer,Old,Tree' && (await warn.locator('.template-plan-removed, .template-plan h4').count()) === 0 && /^removed\b/.test(await removedLine(warn, 'Old')) && /its worktree and branch hive\/templates-ws\/beta\/tree stay/i.test(await removedLine(warn, 'Tree')) && (await created(warn)).join() === 'Builder,Reviewer' && /^Builder builder$/.test((await cells(warn, 'Builder'))[0]), JSON.stringify([await removedLine(warn, 'Tree'), await created(warn), await cells(warn, 'Builder')]))
  // Shown in both themes, each screenshot once the window shows it (a condition, never a fixed wait).
  const themed = async (theme) => {
    await inv('settings:update', { appearance: { theme } })
    if (!(await lib.until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), HUNG_MS))) throw new Error(`the window didn't show the ${theme} theme`)
  }
  for (const theme of ['dark', 'light']) {
    await themed(theme)
    await page.screenshot({ path: path.join(lib.WORK, `templates-3-warning-${theme}.png`) })
  }
  await themed('dark')
  // #702 round 2: a name emptied is marked and Load template greyed out; put back as it was, it can be clicked again.
  const firstName = warn.locator('.template-plan-name-input').first()
  const warnLoad = warn.getByRole('button', { name: 'Load template' })
  await firstName.fill('')
  check('an emptied name is marked, and Load template greyed out', !!(await lib.until(async () => /Enter a name/.test(await warn.locator('.template-plan-table .field-error').first().innerText().catch(() => '')) && (await warnLoad.isDisabled()), HUNG_MS)))
  await firstName.fill('Builder')
  check('…put back, Load template can be clicked again', !!(await lib.until(async () => (await warn.locator('.template-plan-table .field-error').count()) === 0 && (await warnLoad.isEnabled()), HUNG_MS)))
  await agentsOnly(warn)
  await warnLoad.click()
  // The layout with them: this user's view, saved a moment after the agents (HI-1749).
  const loaded = await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]' && projectCfg(beta).layout === 'columns3', 15000)
  check('loading replaces the agents', !!loaded, JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  const b = projectCfg(beta)
  // Not its model (HI-2106: agents hold only a connection, which a template doesn't keep: HI-2109).
  check('…recreating them exactly: role in the workflow, note, the layout; in the project folder', b.agents[0].workflowRole === 'builder' && b.agents[0].role === 'builder' && b.agents[1].workflowRole === 'reviewer' && b.layout === 'columns3' && b.agents.every((a) => !a.worktree), JSON.stringify(b))
  check("the removed worktree agent's worktree stays", fs.existsSync(tree.worktree.path))
  await lib.until(async () => (await lib.agentCount(page)) === 2, 5000)

  // The warning gives each new agent's role in the workflow (its note, and the agent it's paired with: #1436), marks the
  // agents a new one of the same name replaces, and gives each new agent's settings. Cancelled: nothing made.
  fs.writeFileSync(path.join(ws, '.combwork', 'templates', 'trees.json'), JSON.stringify({ version: 2, name: 'Trees', savedAt: new Date().toISOString(), layout: 'columns2', agents: [{ name: 'Builder', role: 'builder', provider: 'claude-code', model: 'opus', effort: 'high' }, { name: 'Helper', role: 'reviewer', note: 'checks UI', provider: 'claude-code' }], pairs: [{ builder: 'Builder', reviewer: 'Helper' }] }))
  await inv('workspace:refresh')
  const branchesBeforeTrees = lib.git(beta, ['branch', '--list'])
  await loadMenu()
  await item('Trees').click()
  const treesWarn = page.locator('.dialog', { hasText: 'Load "Trees"?' })
  await shown(treesWarn, 'treesWarn')
  const tw = await treesWarn.innerText()
  check('the warning marks Builder replaced by a new agent of the same name, Helper new, Reviewer removed', (await stateOf(treesWarn, 'Builder')) === 'replaced' && /^replaced\b/.test(await removedLine(treesWarn, 'Builder')) && (await stateOf(treesWarn, 'Helper')) === 'new' && (await stateOf(treesWarn, 'Reviewer')) === 'removed' && /^removed\b/.test(await removedLine(treesWarn, 'Reviewer')) && (await treesWarn.locator('.template-plan-table tbody tr[data-agent="Builder"]').count()) === 1, tw)
  // Agent, Change, Role, Connection (HI-2109): each on its role's preselected connection, with what it runs under it; the
  // template's model and effort (from before HI-2109) dropped as it was read.
  const builderCells = await cells(treesWarn, 'Builder')
  const helperCells = await cells(treesWarn, 'Helper')
  const connOf = (d, name) => planRow(d, name).locator('.template-plan-connection').getAttribute('data-connection')
  const firstConn = await connOf(treesWarn, 'Builder')
  check("…gives each new agent's role, pairing and connection in a row", builderCells[0] === 'Builder' && builderCells[2] === 'Builder paired: Helper' && !!firstConn && builderCells.length === 4 && helperCells[0] === 'Helper checks UI' && helperCells[2] === 'Reviewer paired: Builder' && (await connOf(treesWarn, 'Helper')) === firstConn && !/opus|high/i.test(builderCells[3]), JSON.stringify([builderCells, helperCells]))
  check('…and nothing of worktrees for the new agents: no Where column, no setup command', (await treesWarn.locator('.template-plan-table thead th').allInnerTexts()).join().toLowerCase() === 'agent,change,role,connection' && !/own worktree|setup command/.test(tw), tw)
  // The Connections section (HI-2109): a row per role, each saying the CLI the template suggests; Same for all one picker;
  // Per agent a row per agent, over its role's. The table follows what is chosen.
  const section = treesWarn.locator('[data-template-connections]')
  const roleRows = async () => section.locator('.template-connections-form [data-connection-for]').evaluateAll((l) => l.map((x) => x.dataset.connectionFor))
  check('the Connections section has a row per role, each saying the CLI it suggests', JSON.stringify(await roleRows()) === JSON.stringify(['*', 'builder', 'reviewer']) && (await section.locator('[data-connection-for="builder"] .template-connections-suggests').innerText()) === 'suggests Claude Code', JSON.stringify(await roleRows()))
  await section.locator('[data-per-agent]').click()
  check('…Per agent unfolds a choice for each agent', !!(await lib.until(async () => (await section.locator('.template-connections-agents [data-connection-for="Helper"] select').count()) === 1, HUNG_MS)))
  for (const theme of ['dark', 'light']) {
    await themed(theme)
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, `templates-7-connections-${theme}.png`) })
  }
  await themed('dark')
  await section.locator('[data-same-for-all]').check()
  check('…Same for all: one choice, no role rows or Per agent', !!(await lib.until(async () => (await section.locator('[data-connection-for="*"] select').count()) === 1 && (await section.locator('[data-connection-for="builder"]').count()) === 0 && (await section.locator('[data-per-agent]').count()) === 0, HUNG_MS)))
  for (const theme of ['dark', 'light']) {
    await themed(theme)
    await page.screenshot({ path: path.join(lib.WORK, `templates-8-same-for-all-${theme}.png`) })
  }
  await themed('dark')
  const planBox = treesWarn.locator('.detail.rich')
  check('the table fits the dialog: no scrolling sideways', await planBox.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  for (const theme of ['dark', 'light']) {
    await themed(theme)
    await page.screenshot({ path: path.join(lib.WORK, `templates-6-load-details-${theme}.png`) })
  }
  await themed('dark')
  await treesWarn.getByRole('button', { name: 'Cancel' }).click()
  check('cancelled: nothing changed', JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]' && lib.git(beta, ['branch', '--list']) === branchesBeforeTrees)
  fs.rmSync(path.join(ws, '.combwork', 'templates', 'trees.json'))
  // #511: twelve agents, builders and reviewers (as Darren's 6Bx6R): one row each, in the template's order; the table
  // scrolls down in its box and never sideways. Both themes. Cancelled.
  const twelve = ['HB1', 'HB2', 'HB3', 'HR1', 'HR2', 'HR3', 'HB4', 'HB5', 'HB6', 'HR4', 'HR5', 'HR6']
  fs.writeFileSync(path.join(ws, '.combwork', 'templates', 'twelve.json'), JSON.stringify({ version: 2, name: 'Twelve', savedAt: new Date().toISOString(), layout: 'grid', agents: twelve.map((name) => ({ name, role: name.startsWith('HB') ? 'builder' : 'reviewer', provider: 'claude-code' })) }))
  await inv('workspace:refresh')
  await loadMenu()
  await item('Twelve').click()
  const twelveWarn = page.locator('.dialog', { hasText: 'Load "Twelve"?' })
  await shown(twelveWarn, 'twelveWarn')
  check('twelve agents: a row each, in the order of the template', (await created(twelveWarn)).join() === twelve.join(), JSON.stringify(await created(twelveWarn)))
  check('…builders and reviewers by their role', (await cells(twelveWarn, 'HB1'))[2] === 'Builder' && (await cells(twelveWarn, 'HR6'))[2] === 'Reviewer', JSON.stringify([await cells(twelveWarn, 'HB1'), await cells(twelveWarn, 'HR6')]))
  const twelveBox = twelveWarn.locator('.detail.rich')
  check('…the table scrolls in its box, never sideways', await twelveBox.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await page.screenshot({ path: path.join(lib.WORK, `templates-10-twelve-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await twelveWarn.getByRole('button', { name: 'Cancel' }).click()
  fs.rmSync(path.join(ws, '.combwork', 'templates', 'twelve.json'))

  // --- + Add ▾ → Add Agent from Template (#975): one agent, the others left alone; Builder's name is taken, so "Builder 2".
  const addButton = strip.locator('.add-menu')
  await addButton.click()
  await menuOpen()
  check('+ Add ▾ offers Configure Agent and Add…, Add Agent, Add Agent from Template and Templates', JSON.stringify(await menuItems()) === '["Configure Agent and Add…","Add Agent","Add Agent from Template","Templates"]', JSON.stringify(await menuItems()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-4-add-menu.png') })
  await item('Add Agent from Template').click()
  await lib.until(async () => (await menuItems()).includes('Builder'), 5000)
  await page.screenshot({ path: path.join(lib.WORK, 'templates-5-add-from.png') })
  await item('Builder').click()
  // Its name asked for (#1440), filled in free: Builder is beta's own already.
  const addOne = page.locator('.dialog', { hasText: 'Add an agent from a template' })
  check('Add Agent from Template asks for its name, filled in free', !!(await lib.until(async () => (await addOne.locator('#dialog-prompt-field').inputValue().catch(() => '')) === 'Builder (beta)', 8000)), await addOne.locator('#dialog-prompt-field').inputValue().catch(() => ''))
  await addOne.getByRole('button', { name: 'Add Agent' }).click()
  check('…and adds it under that name', !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer","Builder (beta)"]', 8000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  check('…with its role in the workflow and note, in the project folder', projectCfg(beta).agents[2].workflowRole === 'builder' && projectCfg(beta).agents[2].role === 'builder' && !projectCfg(beta).agents[2].worktree)
  await lib.until(async () => (await lib.agentCount(page)) === 3, 5000)
  // Configure Agent and Add…: the dialog, nothing added until it's confirmed.
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  const addDialog = page.locator('.dialog', { hasText: 'Add an agent' })
  check('Configure Agent and Add… opens the Add Agent dialog', !!(await lib.until(async () => (await addDialog.count()) === 1, 5000)))
  await lib.sleep(500)
  check('…without adding an agent', projectCfg(beta).agents.length === 3, JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  // #702: another project's agent's name is refused, saying whose, with a free one to use.
  const nameField = addDialog.locator('.agent-form input.input').first()
  await nameField.fill('alpha builder')
  const taken = addDialog.locator('[data-name-taken]')
  check("Add Agent refuses another project's agent's name, saying whose", !!(await lib.until(async () => /alpha already has an agent called Alpha builder: agent names are unique across the workspace\. Use alpha builder \(beta\)/.test(await taken.innerText().catch(() => '')), HUNG_MS)) && (await addDialog.getByRole('button', { name: 'Add Agent' }).isDisabled()), await taken.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-11-name-taken.png') })
  await taken.locator('a').click()
  check('…and its suggestion fills the name in', (await nameField.inputValue()) === 'alpha builder (beta)' && (await taken.count()) === 0 && (await addDialog.getByRole('button', { name: 'Add Agent' }).isEnabled()), await nameField.inputValue())
  // No worktree to choose (#1442): it says where the agent works instead.
  check('Add Agent offers no worktree, saying where an agent works', (await addDialog.locator('.choice', { hasText: /New worktree|Existing worktree/ }).count()) === 0 && (await addDialog.locator('[data-where-note]').count()) === 1)
  await page.keyboard.press('Escape')
  await lib.until(async () => (await addDialog.count()) === 0, HUNG_MS)

  // The keyboard: Enter on + Add ▾ opens the menu on its first entry, ↓ moves, → opens Add Agent from Template, Enter adds.
  const active = () => page.locator('.menu .menu-item.active').innerText().then((t) => t.split('\n')[0].trim(), () => '')
  await addButton.focus()
  await page.keyboard.press('Enter')
  await menuOpen()
  check('Enter on + Add ▾ opens its menu on Configure Agent and Add…', (await active()) === 'Configure Agent and Add…', await active())
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  check('↓ ↓ moves to Add Agent from Template', (await active()) === 'Add Agent from Template', await active())
  await page.keyboard.press('ArrowRight')
  await lib.until(async () => (await menuItems()).includes('Reviewer'), 5000)
  const first = (await page.locator('.menu .menu-item:not(.disabled)').first().innerText()).split('\n')[0].trim()
  check('→ opens the template agents on the first one', (await active()) === first, `${await active()} / ${first}`)
  // (Past Hive's own templates' agents first, #1436.)
  for (let i = 0; i < 80 && (await active()) !== 'Reviewer'; i++) await page.keyboard.press('ArrowDown')
  check('→ opens the template agents, ↓ reaches Reviewer', (await active()) === 'Reviewer', await active())
  await page.keyboard.press('Enter')
  // Enter chose it: its name dialog (#1440) opens, its free name filled in.
  check('Enter chooses it: its name asked for, filled in free', !!(await lib.until(async () => (await addOne.locator('#dialog-prompt-field').inputValue().catch(() => '')) === 'Reviewer (beta)', 8000)), await addOne.locator('#dialog-prompt-field').inputValue().catch(() => ''))
  await addOne.getByRole('button', { name: 'Add Agent' }).click()
  check('…and it is added', !!(await lib.until(async () => projectCfg(beta).agents.map((a) => a.name).includes('Reviewer (beta)'), 8000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  await lib.until(async () => (await lib.agentCount(page)) === 4, 5000)

  // The palette: Load Template… and Add Agent from Template… open + Add ▾'s menus, on their first entry.
  const palette = async (label) => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').fill(label)
    await lib.sleep(300)
    await page.locator('.palette-item', { hasText: label }).first().click()
    await menuOpen()
  }
  await palette('Load Template…')
  check('the palette\'s Load Template… opens Templates ▸ on Save Template…', (await active()) === 'Save Template…' && (await menuItems()).includes('pair'), `${await active()} ${JSON.stringify(await menuItems())}`)
  await page.keyboard.press('Escape')
  await palette('Add Agent from Template…')
  check('the palette\'s Add Agent from Template… lists the template agents', (await menuItems()).includes('Builder') && (await active()) !== '', `${await active()} ${JSON.stringify(await menuItems())}`)
  await page.keyboard.press('Escape')

  // --- Narrow (#975): Panes | Tiles, the summary chip, the pages, the layouts and + Add ▾ inside the toolbar and
  // clickable, in both themes, in that order, none overlapping the next (#292).
  const PARTS = ['.view-switch', '.summary-chip', '.page-switch', '.layout-switch', '.add-menu']
  const reachable = async () =>
    page.evaluate(() => {
      const s = document.querySelector('.session-toolbar').getBoundingClientRect()
      const els = [...document.querySelectorAll('.view-switch button, .session-toolbar .summary-chip, .page-switch button, .layout-switch button, .session-toolbar .add-menu')]
      return els.length > 0 && els.every((el) => {
        const r = el.getBoundingClientRect()
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.right <= window.innerWidth && !!t && (t === el || el.contains(t))
      })
    })
  const order = () =>
    page.evaluate((parts) => {
      const els = parts.map((p) => [p, document.querySelector(`.session-toolbar ${p}`)]).filter(([, el]) => el)
      const boxes = els.map(([, el]) => el.getBoundingClientRect())
      return { names: els.map(([p]) => p.slice(1)), inOrder: boxes.every((box, i) => i === 0 || boxes[i - 1].right <= box.left + 0.5) }
    }, PARTS)
  for (const width of [1700, 1200, 900]) {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.fitWindow(app, page, { width, height: 900 })
      const ok = await lib.until(async () => (await reachable()) && (await order()).inOrder, HUNG_MS)
      check(`${theme}, ${width} px: the toolbar's controls are inside it and clickable`, !!ok && (await reachable()))
      const o = await order()
      check('…in the order Panes | Tiles, summary chip, pages, layouts, + Add ▾, none overlapping', o.inOrder && JSON.stringify(o.names) === '["view-switch","summary-chip","page-switch","layout-switch","add-menu"]', JSON.stringify(o))
      await page.screenshot({ path: path.join(lib.WORK, `templates-toolbar-${width}-${theme}.png`), clip: { x: 0, y: 0, width, height: 160 } })
    }
  }
  // One page (the grid of six shows all four): no page buttons.
  await inv('project:updateConfig', beta, { layout: 'grid6' })
  await inv('workspace:refresh')
  await lib.until(async () => (await strip.locator('.page-switch').count()) === 0, 5000)
  for (const width of [1700, 900]) {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.fitWindow(app, page, { width, height: 900 })
      const ok = await lib.until(async () => (await reachable()) && (await order()).inOrder, HUNG_MS)
      const o = await order()
      check(`${theme}, ${width} px, one page: Panes | Tiles, summary chip, layouts, + Add ▾, none overlapping, all clickable`, !!ok && o.inOrder && JSON.stringify(o.names) === '["view-switch","summary-chip","layout-switch","add-menu"]', JSON.stringify(o))
      await page.screenshot({ path: path.join(lib.WORK, `templates-toolbar-1page-${width}-${theme}.png`), clip: { x: 0, y: 0, width, height: 160 } })
    }
  }
  await inv('project:updateConfig', beta, { layout: 'columns3' })
  await inv('workspace:refresh')
  await lib.until(async () => (await strip.locator('.page-switch').count()) === 1, 5000)
  await templateMenu()
  check('at 900 px Templates ▸ still has Save Template… and the templates', (await menuItems())[0] === 'Save Template…' && (await menuItems()).includes('pair'), JSON.stringify(await menuItems()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-toolbar-900-menu.png') })
  await page.keyboard.press('Escape')
  await inv('settings:update', { appearance: { theme: 'dark' } })

  await inv('session:stop', beta)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)

  // --- #268: alpha's own template, with a worktree agent ("Tree"), loaded into beta from the Templates view (#1436:
  // its agents in beta's folder, no worktree or branch made, alpha's untouched). #702: each agent's name in the
  // template beside a box for the name it gets: names alpha's agents have, or used twice, marked, Load template greyed
  // out until they are changed.
  await select('alpha')
  const srcTree = await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  await inv('workspace:refresh')
  await saveTemplate()
  await shown(dialog, 'dialog')
  await dialog.locator('input.input').fill('Alpha trees')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const alphaTrees = path.join(alpha, '.combwork', 'templates', 'alpha-trees.json')
  check("alpha's own template saved, its agents' roles and no worktree, path or branch", !!(await lib.until(async () => fs.existsSync(alphaTrees), 5000)) && /"name": "Tree",\s*"role": "builder"/.test(fs.readFileSync(alphaTrees, 'utf8')) && !/worktree|hive\/templates-ws/.test(fs.readFileSync(alphaTrees, 'utf8')))
  // alpha's Tree renamed after saving (its worktree stays), so the template's Tree is free in beta; its other two aren't.
  await inv('agents:update', alpha, srcTree.id, { name: 'Alpha tree' })
  const srcCfg = JSON.stringify(projectCfg(alpha).agents.find((a) => a.id === srcTree.id).worktree)
  const betaBranches = lib.git(beta, ['branch', '--list'])
  const betaTrees = lib.git(beta, ['worktree', 'list', '--porcelain'])
  await page.locator('.activitybar [aria-label="Templates"]').click()
  await page.locator('.sidebar .template-row[aria-label="Alpha trees"]').first().click()
  const tplDetail = page.locator('.main-area > .tab-body .template-detail')
  await tplDetail.getByRole('button', { name: 'Load into Project…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  const crossLoad = page.locator('.dialog', { hasText: 'Load "Alpha trees"?' })
  await shown(crossLoad, 'crossLoad')
  const nameInputs = crossLoad.locator('.template-plan-name-input')
  const namesNow = () => nameInputs.evaluateAll((l) => l.map((x) => x.value))
  const fromNames = () => crossLoad.locator('.template-plan-from').allInnerTexts()
  const errors = () => crossLoad.locator('.template-plan-table .field-error').allInnerTexts()
  const loadButton = crossLoad.getByRole('button', { name: 'Load template' })
  // #1440: the two names alpha's agents have start as free ones, so loading is one click; the others as they are.
  check("each name in the template beside a box for its new one: alpha's two filled in free", JSON.stringify(await fromNames()) === '["Alpha builder","Alpha reviewer","Tree"]' && JSON.stringify(await namesNow()) === '["Alpha builder (beta)","Alpha reviewer (beta)","Tree"]', JSON.stringify([await fromNames(), await namesNow()]))
  check("…saying why, none marked, Load template ready", (await errors()).length === 0 && /these names are taken already: Alpha builder, Alpha reviewer \(projects: alpha\)\. Free names are filled in below\./.test(await crossLoad.locator('[data-names-taken]').innerText()) && (await loadButton.isEnabled()), JSON.stringify([await errors(), await crossLoad.locator('[data-names-taken]').innerText()]))
  // One edited back to alpha's: marked, saying so, and Load template greyed out.
  await nameInputs.nth(0).fill('Alpha builder')
  check("…one edited to alpha's agent's name is marked, Load template greyed out", !!(await lib.until(async () => JSON.stringify(await errors()) === '["alpha has an agent called Alpha builder."]' && (await loadButton.isDisabled()), HUNG_MS)), JSON.stringify(await errors()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-13-names-taken.png') })
  // One changed, the other still alpha's: still greyed out. A name used twice is marked too.
  await nameInputs.nth(0).fill('BAB')
  await nameInputs.nth(1).fill('bab')
  check('…a name used twice is marked, and Load template stays greyed out', !!(await lib.until(async () => JSON.stringify(await errors()) === '["Another of its agents has this name."]', HUNG_MS)) && (await loadButton.isDisabled()), JSON.stringify(await errors()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-14-name-twice.png') })
  await nameInputs.nth(1).fill('BAR')
  check('…all free: Load template can be clicked, the template names unchanged', !!(await lib.until(async () => (await errors()).length === 0 && (await loadButton.isEnabled()), HUNG_MS)) && JSON.stringify(await fromNames()) === '["Alpha builder","Alpha reviewer","Tree"]', JSON.stringify(await errors()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-7-cross-project.png') })
  await agentsOnly(crossLoad)
  await loadButton.click()
  check("loaded into beta: alpha's agents, with the names chosen", !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["BAB","BAR","Tree"]', 15000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  check("…each in beta's folder: no worktree or branch made", projectCfg(beta).agents.every((a) => !a.worktree) && lib.git(beta, ['branch', '--list']) === betaBranches && lib.git(beta, ['worktree', 'list', '--porcelain']) === betaTrees)
  check("alpha's Tree and its worktree are untouched", JSON.stringify(projectCfg(alpha).agents.find((a) => a.id === srcTree.id).worktree) === srcCfg && fs.existsSync(srcTree.worktree.path) && lib.git(srcTree.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === srcTree.worktree.branch)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
