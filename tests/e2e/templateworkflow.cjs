// A template's workflow (HI-1910), on fake Claude Code with the Assistant off: Save as Template from a Git project with
// options of its own (gita: Team made its own; its target, commands and identity) keeps its rules as the Git section,
// ticked by default, never its target, commands or identity's name. Loaded into another Git project (gitb: its own
// target, one command), the Load dialog shows what its workflow changes and the check gitb has no command for; loading
// opens Version Control → Workflow with it filled in, nothing saved until Save…, then gitb's own target and command
// kept. Saved again from the None project (plain), its Git section is kept and said so; loaded into plain, None's is
// used, with a hint that it has Git's too. A Git-only template in plain: Load is greyed out until Git, unticking loads
// only the agents; Set Up Git… closes the dialog for Version Control's Git page, and after Initialise repository… the
// project is Git and the dialog opens again. The Templates view shows the sections under None | Git tabs, and its editor
// removes one. HR5's round 1: an imported template whose section can't be used says so in the Load dialog and offers no
// preset in its place; the workflow applied is the one the dialog shows last (edited and refreshed while it is open),
// and one changed after that is said, never filled in. Screenshots in both themes. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'templateworkflow-profile')
const ws = path.join(lib.WORK, 'templateworkflow-ws')
const claudeHome = path.join(lib.WORK, 'templateworkflow-claude-home')
const shots = path.join(lib.WORK, 'templateworkflow-shots')
const gita = path.join(ws, 'gita')
const gitb = path.join(ws, 'gitb')
const plain = path.join(ws, 'plain')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn) => lib.until(fn, HUNG_MS, 150)

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots, ...[gita, gitb, plain].map((p) => path.join(p, '.hive'))]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(plain, 'notes.md'), '# Notes\n')
  for (const [p, who] of [[gita, 'A'], [gitb, 'B']]) {
    lib.gitProject(p)
    lib.git(p, ['branch', '-M', 'main'])
    lib.git(p, ['config', 'user.name', `${who} Person`])
    lib.git(p, ['config', 'user.email', `${who.toLowerCase()}@example.com`])
  }
  // gita: Team made its own (its target, commands, identity, stage names, loops); gitb: its own target and one command.
  const own = { review: 'agent', noSelfReview: true, preChecks: ['lint', 'unit'], commands: { lint: 'npm run lint', unit: 'npm test' }, target: 'stable-line', identity: { name: 'A Person', email: 'a@example.com' }, stageNames: { review: 'Checking' }, loopRounds: 4 }
  fs.writeFileSync(path.join(gita, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'a-wa1', name: 'WA-B1', workflowRole: 'builder', provider: 'claude-code' }], workflow: { platform: 'git', preset: 'team', options: own } }))
  fs.writeFileSync(path.join(gitb, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [], workflow: { platform: 'git', preset: null, options: { target: 'main', commands: { lint: 'pnpm lint' } } } }))
  fs.writeFileSync(path.join(plain, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'a-wp1', name: 'WP-B1', workflowRole: 'builder', provider: 'claude-code' }] }))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws, gita, gitb, plain].map((p) => p.toLowerCase())))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47793), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' }, viewport: { width: 1500, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const text = async (l) => ((await l.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const dialog = page.locator('.dialog').last()
    const fileOf = (name) => JSON.parse(fs.readFileSync(path.join(ws, '.hive', 'templates', name), 'utf8'))
    const workflowOf = (p) => JSON.parse(fs.readFileSync(path.join(p, '.hive', 'project.json'), 'utf8')).workflow
    const shoot = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        await page.mouse.move(5, 5)
        await target().screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    const select = async (name) => {
      await page.locator('.project-row', { hasText: name }).first().click()
      if (!(await until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === name))) throw new Error(`${name} wasn't selected`)
    }
    const menuItems = async () => (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.split('\n')[0].trim())
    const item = (label) => page.locator('.menu .menu-item').filter({ has: page.getByText(label, { exact: true }) }).first()
    const templatesMenu = async (then) => {
      await lib.addMenuRun(page, 'Templates')
      if (!(await until(async () => (await menuItems()).includes(then)))) throw new Error(`Templates ▸ has no ${then}: ${JSON.stringify(await menuItems())}`)
      await item(then).click()
    }
    const saveAs = async (name, { workspace = true, workflow = true, replace = false } = {}) => {
      await templatesMenu('Save Template…')
      await until(() => dialog.locator('input.input').isVisible())
      await dialog.locator('input.input').fill(name)
      if (workspace) await dialog.locator('input[type="checkbox"]').first().check()
      const wf = dialog.locator('[data-check3] input')
      if (workflow) await wf.check()
      else await wf.uncheck()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      if (replace) {
        const ask = page.locator('.dialog', { hasText: 'Replace the template?' })
        await until(async () => (await ask.count()) === 1)
        await ask.getByRole('button', { name: 'Replace' }).click()
      }
    }
    const loadDialog = (name) => page.locator('.dialog', { hasText: `Load "${name}"?` })
    const loadButton = (d) => d.getByRole('button', { name: 'Load template' })

    // --- Save as Template from gita: its workflow ticked by default, its rules as the Git section.
    await select('gita')
    await templatesMenu('Save Template…')
    const wfBox = dialog.locator('[data-check3] input')
    check('Save as Template has "Include this project\'s workflow", ticked by default, naming Git', !!(await until(async () => (await wfBox.count()) === 1 && (await wfBox.isChecked()) && /Include this project's workflow \(its rules for Git/.test(await text(dialog.locator('[data-check3]'))))), await text(dialog))
    await dialog.locator('input.input').fill('Team A')
    await dialog.locator('input[type="checkbox"]').first().check()
    await shoot('1-save', () => dialog)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    const teamA = path.join(ws, '.hive', 'templates', 'team-a.json')
    check('saved: its Git section with the rules, never its target, commands or identity', !!(await until(() => fs.existsSync(teamA))) && JSON.stringify(Object.keys(fileOf('team-a.json').workflow)) === '["git"]' && fileOf('team-a.json').workflow.git.options.review === 'agent' && fileOf('team-a.json').workflow.git.options.identity === true && !/stable-line|npm run lint|npm test|A Person|a@example\.com|"target"|"commands"/.test(JSON.stringify(fileOf('team-a.json').workflow)), JSON.stringify(fileOf('team-a.json').workflow))
    check('…and the notice says it holds the workflow for Git', !!(await until(async () => /It holds this project's workflow for Git\./.test(await text(page.locator('.toast', { hasText: 'Template saved' }))))))

    // --- Into gitb: the Load dialog's Workflow part, then the Workflow form filled in, saved there.
    await select('gitb')
    const gitbBefore = JSON.stringify(workflowOf(gitb))
    await templatesMenu('Team A')
    const load = loadDialog('Team A')
    const part = load.locator('[data-template-workflow="git"]')
    check('the Load dialog shows its workflow for Git: ticked, what it changes, the check gitb has no command for', !!(await until(async () => (await part.count()) === 1 && (await part.locator('[data-workflow-apply]').isChecked()) && (await part.locator('li[data-option="review"]').count()) === 1 && (await part.locator('[data-workflow-no-command]').getAttribute('data-workflow-no-command')) === 'unit')), await text(part))
    check('…never gita’s target or commands', !/stable-line|npm run lint|A Person/.test(await text(load)))
    await shoot('2-load-git', () => load)
    await loadButton(load).click()
    const banner = page.locator('[data-from-template="Team A"]')
    check('loaded: Version Control → Workflow opens with it filled in, saying so, the missing command flagged', !!(await until(async () => (await banner.count()) === 1 && (await banner.locator('[data-template-no-command]').getAttribute('data-template-no-command')) === 'unit')), await text(page.locator('.vc-view')))
    // Only its Maximum agents is saved, with its agents (HI-2058): gita's 12, as gitb's own even though it inherits 12.
    const withoutMax = (w) => (w ? { ...w, options: Object.fromEntries(Object.entries(w.options ?? {}).filter(([k]) => k !== 'maxAgents')) } : w)
    // The note says what is saved already (HI-2083): its Maximum agents, with its agents; the rest awaits Save.
    check('…the note says its Maximum agents (12) is saved already and the other options aren’t yet', /Its Maximum agents \(12\) is saved already, with its agents; the other options aren’t saved yet/.test(await text(banner)), await text(banner))
    check('…and nothing else saved yet: its Maximum agents saved with its agents', JSON.stringify(withoutMax(workflowOf(gitb))) === JSON.stringify(withoutMax(gitbBefore === undefined ? undefined : JSON.parse(gitbBefore))) && workflowOf(gitb)?.options?.maxAgents === 12, JSON.stringify(workflowOf(gitb)))
    await shoot('3-filled', () => page.locator('.vc-view'))
    await page.locator('.workflow-actions [data-action="save"]').click()
    const confirmSave = page.locator('.dialog', { hasText: 'Save' }).last()
    await until(async () => (await confirmSave.getByRole('button', { name: 'Save', exact: true }).count()) === 1)
    await confirmSave.getByRole('button', { name: 'Save', exact: true }).click()
    const saved = () => workflowOf(gitb)?.options ?? {}
    check("Save…: its rules in gitb's options, gitb's target and command its own", !!(await until(() => saved().review === 'agent' && JSON.stringify(saved().preChecks) === '["lint","unit"]')) && saved().target === 'main' && JSON.stringify(saved().commands) === '{"lint":"pnpm lint"}' && !/A Person|stable-line/.test(JSON.stringify(saved())), JSON.stringify(saved()))
    check('…its identity gitb’s own, never gita’s', saved().identity?.email === 'b@example.com', JSON.stringify(saved().identity))
    check('…and the banner goes', !!(await until(async () => (await banner.count()) === 0)))

    // --- HI-2269: gitb's identity corrected in git after G12 was saved on: loading Team A (G12 on) again changes nothing
    // of G12, and never shows the saved copy as its value now.
    lib.git(gitb, ['config', 'user.name', 'B Fixed'])
    lib.git(gitb, ['config', 'user.email', 'b.fixed@example.com'])
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    await templatesMenu('Team A')
    const reload = loadDialog('Team A')
    const reloadPart = reload.locator('[data-template-workflow="git"]')
    await until(async () => (await reloadPart.locator('[data-workflow-changes]').count()) === 1)
    check("HI-2269: G12 on already, its saved copy stale: not among what loading changes, the saved copy's email nowhere", (await reloadPart.locator('li[data-option="identity"]').count()) === 0 && !(await text(reload)).includes('b@example.com'), await text(reload))
    await shoot('3b-identity-stale', () => reload)
    await reload.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await reload.count()) === 0)
    lib.git(gitb, ['config', 'user.name', 'B Person'])
    lib.git(gitb, ['config', 'user.email', 'b@example.com'])

    // --- Saved again from plain (None): its None section added, Git's kept and said so; loaded into plain, None's used.
    await select('plain')
    await saveAs('Team A', { replace: true })
    check("saving over it from a None project adds None's section and keeps Git's, saying so", !!(await until(() => JSON.stringify(Object.keys(fileOf('team-a.json').workflow ?? {}).sort()) === '["git","none"]')) && !!(await until(async () => /The workflow for Git it had is kept\./.test(await text(page.locator('.toast', { hasText: 'Template saved' }).last())))), await text(page.locator('.toast').last()))
    await templatesMenu('Team A')
    const intoPlain = loadDialog('Team A')
    check("into plain: None's section, with a hint that it has Git's too", !!(await until(async () => (await intoPlain.locator('[data-template-workflow="none"]').count()) === 1 && (await intoPlain.locator('[data-workflow-also-git]').count()) === 1)), await text(intoPlain.locator('.template-workflow')))
    await intoPlain.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await intoPlain.count()) === 0)

    // --- A Git-only template in plain: held until Git, untick to load only the agents; Set Up Git…, then the dialog again.
    await select('gita')
    await saveAs('Git only')
    await until(() => fs.existsSync(path.join(ws, '.hive', 'templates', 'git-only.json')))
    await select('plain')
    await templatesMenu('Git only')
    const gitOnly = loadDialog('Git only')
    const needs = gitOnly.locator('[data-workflow-needs-git]')
    check('a Git-only workflow in a project with no version control: it needs Git, and Load is greyed out', !!(await until(async () => (await needs.count()) === 1 && (await loadButton(gitOnly).isDisabled()))), await text(gitOnly.locator('.template-workflow')))
    await shoot('4-needs-git', () => gitOnly)
    await gitOnly.locator('[data-workflow-apply]').uncheck()
    check('…unticked, Load can be clicked: only its agents would load', !!(await until(async () => (await needs.count()) === 0 && (await loadButton(gitOnly).isEnabled()))))
    await gitOnly.locator('[data-workflow-apply]').check()
    await until(async () => (await needs.count()) === 1)
    const plainAgents = JSON.stringify(JSON.parse(fs.readFileSync(path.join(plain, '.hive', 'project.json'), 'utf8')).agents.map((a) => a.name))
    await needs.locator('[data-action="template-set-up-git"]').click()
    const preview = page.locator('[data-vc-git-preview]')
    check("Set Up Git… closes the dialog, nothing loaded, and opens Git's page saying the template waits", !!(await until(async () => (await gitOnly.count()) === 0 && (await preview.count()) === 1 && (await preview.locator('[data-vc-template-pending]').count()) === 1)) && JSON.stringify(JSON.parse(fs.readFileSync(path.join(plain, '.hive', 'project.json'), 'utf8')).agents.map((a) => a.name)) === plainAgents, await text(page.locator('.vc-view')))
    await shoot('5-set-up-git', () => page.locator('.vc-view'))
    await preview.locator('[data-git-init]').click()
    const init = page.locator('.dialog', { hasText: 'Initialise plain as a git repository' })
    await until(async () => (await init.locator('[data-git-init-form]').count()) === 1)
    if (await init.locator('#git-init-name').count()) await init.locator('#git-init-name').fill('Plain Person')
    if (await init.locator('#git-init-email').count()) await init.locator('#git-init-email').fill('plain@example.com')
    await init.getByRole('button', { name: 'Initialise', exact: true }).click()
    const again = loadDialog('Git only')
    check('initialised and switched to Git: the Load dialog opens again, its Git workflow now applying', !!(await until(async () => (await init.count()) === 0 && (await again.count()) === 1 && (await again.locator('[data-template-workflow="git"]').count()) === 1 && (await loadButton(again).isEnabled()))), await text(again))
    check('…plain is Git now', (await inv('workflow:form', plain)).platform === 'git')
    await again.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await again.count()) === 0)

    // --- The Templates view: Team A's sections under None | Git; the editor removes one.
    await page.locator('.activitybar .activity-btn[aria-label="Templates"]').click()
    await page.locator('.template-row', { hasText: 'Team A' }).first().click()
    const view = page.locator('[data-template-workflow-view]')
    check("the Templates view shows its workflow under None | Git tabs", !!(await until(async () => (await view.locator('[role="tab"][data-workflow-platform="none"]').count()) === 1 && (await view.locator('[role="tab"][data-workflow-platform="git"]').count()) === 1 && (await view.locator('[data-workflow-section="git"] li[data-option="review"]').count()) === 1)), await text(view))
    await shoot('6-view', () => page.locator('.template-detail'))
    await page.locator('.template-detail-actions button', { hasText: 'Edit…' }).click()
    const editor = page.locator('.template-editor [data-template-workflow-view]')
    await until(async () => (await editor.count()) === 1)
    await editor.locator('[role="tab"][data-workflow-platform="none"]').click()
    await editor.locator('[data-workflow-remove="none"]').click()
    await page.locator('.template-editor .template-detail-actions button', { hasText: 'Save Template' }).click()
    check("the editor removes None's section, Git's kept", !!(await until(() => JSON.stringify(Object.keys(fileOf('team-a.json').workflow ?? {})) === '["git"]')), JSON.stringify(fileOf('team-a.json').workflow))

    // --- HR5's round 1, 1: imported with a section Hive can't use: said, and no preset offered in its place.
    await page.locator('.activitybar [aria-label="Projects"]').click()
    await select('gitb')
    // gitb last showed Version Control: its Session tab, for + Add ▾.
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    const bad =path.join(lib.WORK, 'templateworkflow-bad.hive-template.json')
    fs.writeFileSync(bad, JSON.stringify({ version: 2, name: 'Bad none', savedAt: '', layout: 'auto', suggestedPreset: 'pair', agents: [{ name: 'BD-B1', role: 'builder', provider: 'claude-code' }], workflow: { none: { preset: null, options: { review: 'bogus' } } } }))
    const imported = await inv('templates:import', bad, { scope: 'workspace' })
    check('imported, its rejected section kept as rejected (never what it held)', !!imported?.imported && JSON.stringify(imported.imported.workflowDropped) === '["none"]' && !/bogus/.test(fs.readFileSync(path.join(ws, '.hive', 'templates', imported.imported.file), 'utf8')), JSON.stringify(imported))
    await templatesMenu('Bad none')
    const badLoad = loadDialog('Bad none')
    check('its Load dialog says the section can’t be used, and offers no preset in its place', !!(await until(async () => (await badLoad.locator('[data-workflow-dropped="none"]').count()) === 1)) && (await badLoad.locator('.dialog-check').count()) === 0, await text(badLoad))
    await badLoad.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await badLoad.count()) === 0)

    // --- HR5's round 1, 2: the workflow applied is the one shown last. A template edited while its dialog is open: the
    // plan read again (a name changed) shows it, and Load fills that in; changed again after it, the load says so.
    const roundsFile = path.join(ws, '.hive', 'templates', 'rounds.json')
    const writeRounds = (n) => fs.writeFileSync(roundsFile, JSON.stringify({ version: 2, name: 'Rounds', savedAt: new Date().toISOString(), layout: 'auto', agents: [{ name: 'RD-B1', role: 'builder', provider: 'claude-code' }], workflow: { git: { preset: null, options: { loopRounds: n } } } }))
    writeRounds(6)
    await inv('templates:list', gitb)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const openRounds = async () => {
      await lib.addMenuRun(page, 'Templates')
      if (!(await until(async () => (await menuItems()).includes('Rounds')))) {
        // The menu reads the templates when it opens: closed and opened again once the file is listed.
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await lib.addMenuRun(page, 'Templates')
        await until(async () => (await menuItems()).includes('Rounds'))
      }
      await item('Rounds').click()
      return loadDialog('Rounds')
    }
    const rounds = await openRounds()
    const roundsRow = rounds.locator('li[data-option="loopRounds"]')
    const roundsTo = async (row, n) => (await text(row)).trim().endsWith(`→ ${n}`)
    check('the dialog shows its rounds', !!(await until(() => roundsTo(roundsRow, 6))), await text(rounds.locator('.template-workflow')))
    writeRounds(8)
    await rounds.locator('.template-plan-name-input').first().fill('RD-B2')
    check('edited while open: the plan read again shows the new value', !!(await until(() => roundsTo(roundsRow, 8))), await text(rounds.locator('.template-workflow')))
    await loadButton(rounds).click()
    const roundsBox = page.locator('[data-option="loopRounds"] input')
    check('Load fills in the value shown, never the first one read', !!(await until(async () => (await page.locator('[data-from-template="Rounds"]').count()) === 1 && (await roundsBox.inputValue()) === '8')), await roundsBox.inputValue().catch(() => ''))
    await page.locator('.workflow-actions button', { hasText: 'Discard Changes' }).click()
    await until(async () => (await page.locator('[data-from-template]').count()) === 0)
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    const again2 = await openRounds()
    await until(() => roundsTo(again2.locator('li[data-option="loopRounds"]'), 8))
    writeRounds(9)
    await loadButton(again2).click()
    check('changed after the dialog last read it: the load says so, and fills nothing in', !!(await until(async () => (await page.locator('.toast', { hasText: 'changed while it loaded' }).count()) === 1)) && (await page.locator('[data-from-template]').count()) === 0)

    // --- HI-2067 (HI-2033's fix): a preset chosen while the template's read of the form waits stays chosen. main's
    // workflow:form for gitb answers from the form as it is now, each read held until the test lets it go (as
    // workflowoptions' late reads); the form's own first read let through, the template's held, Team chosen and used,
    // then the template's answered: it is dropped, and Save… saves Team with gitb's target and command. Last here: the
    // handler stays replaced until the app closes.
    const lateFile = path.join(ws, '.hive', 'templates', 'late.json')
    fs.writeFileSync(lateFile, JSON.stringify({ version: 2, name: 'Late', savedAt: new Date().toISOString(), layout: 'auto', agents: [{ name: 'LT-B1', role: 'builder', provider: 'claude-code' }], workflow: { git: { preset: null, options: { loopRounds: 7 } } } }))
    await inv('templates:list', gitb)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    const model = await inv('workflow:form', gitb)
    const others = { [gita.toLowerCase()]: await inv('workflow:form', gita), [plain.toLowerCase()]: await inv('workflow:form', plain) }
    await app.evaluate(({ ipcMain }, [p, m, o]) => {
      globalThis.__late = { hold: false, held: [] }
      ipcMain.removeHandler('workflow:form')
      ipcMain.handle('workflow:form', (_e, x) => {
        const s = globalThis.__late
        if (String(x).toLowerCase() !== p.toLowerCase()) return o[String(x).toLowerCase()]
        return s.hold ? new Promise((r) => s.held.push(r)) : m
      })
    }, [gitb, model, others])
    const hold = (on) => app.evaluate((_, v) => void (globalThis.__late.hold = v), on)
    const heldNow = () => app.evaluate(() => globalThis.__late.held.length)
    const release = () => app.evaluate((_, m) => void globalThis.__late.held.splice(0).forEach((r) => r(m)), model)
    await hold(true)
    await lib.addMenuRun(page, 'Templates')
    if (!(await until(async () => (await menuItems()).includes('Late')))) {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await lib.addMenuRun(page, 'Templates')
      await until(async () => (await menuItems()).includes('Late'))
    }
    await item('Late').click()
    const late = loadDialog('Late')
    await until(async () => (await loadButton(late).count()) === 1 && (await loadButton(late).isEnabled()))
    await loadButton(late).click()
    // The form's first read let through; once the form shows, the template's own read is the one held.
    const team = page.locator('.workflow-form .workflow-choice[data-choice="team"]')
    check("Late loaded: the form's first read is held", !!(await until(async () => (await heldNow()) > 0)))
    await release()
    check("…let through, the form shows while the template's read is held, nothing filled in yet", !!(await until(async () => (await team.count()) === 1 && (await heldNow()) > 0)) && (await page.locator('[data-from-template]').count()) === 0)
    await team.click()
    const teamPreview = page.locator('.workflow-form .workflow-preview')
    await teamPreview.waitFor({ timeout: HUNG_MS })
    await teamPreview.locator('[data-action="use-choice"]').click()
    await teamPreview.waitFor({ state: 'detached', timeout: HUNG_MS })
    await release()
    await hold(false)
    // A read of the window's own answered after it: the held answer has been taken (or dropped) by then.
    await inv('workflow:form', gitb)
    check("Team chosen while the template's read waited stays chosen: the read's answer is dropped, nothing of Late filled in", !!(await until(async () => (await page.locator('.workflow-form .workflow-choice.current[data-choice="team"]').count()) === 1)) && (await page.locator('[data-from-template]').count()) === 0 && (await page.locator('[data-option="loopRounds"] input').inputValue().catch(() => '')) !== '7', JSON.stringify({ current: await page.locator('.workflow-form .workflow-choice.current').getAttribute('data-choice').catch(() => null), filled: await text(page.locator('[data-from-template]')) }))
    await page.locator('.workflow-actions [data-action="save"]').click()
    const confirmLate = page.locator('.dialog', { hasText: 'Save' }).last()
    await until(async () => (await confirmLate.getByRole('button', { name: 'Save', exact: true }).count()) === 1)
    await confirmLate.getByRole('button', { name: 'Save', exact: true }).click()
    check("…saved as Team, with gitb's target and command, never Late's rounds", !!(await until(() => workflowOf(gitb)?.preset === 'team' && saved().finish === 'hiveMerges')) && saved().target === 'main' && saved().commands?.lint === 'pnpm lint' && saved().loopRounds !== 7, JSON.stringify(workflowOf(gitb)))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
