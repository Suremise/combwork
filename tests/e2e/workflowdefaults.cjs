// Workflow defaults at Hive's and the workspace's level (#1422, SPEC §16.6.6): the Workflow section's editor in a level
// mode, in Settings → Workspace (the workspace's) and Settings → Workflow defaults (Hive's), each for None or for Git.
// A workspace default set there: Save… lists the project inheriting it, the project's options show "From the workspace"
// and its next card starts under them (a card started before keeps its rules). A project's own value still wins. Hive's
// default sits under the workspace's (From Hive's settings). A level that would make an inheriting project contradictory
// is refused, naming the project, and nothing is written. Screenshots in both themes. Dev build, throwaway profile and
// workspace; no CLI is started, and the Assistant is off.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'workflowdefaults-profile')
const ws = path.join(lib.WORK, 'workflowdefaults-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  // A Git project that sets no workflow option itself: it inherits every one.
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: null, options: {} }, loopRounds: 8, fileLocks: 'warn', loopWakes: true }))
  // Saved by a build from before HI-1766: the workspace's Card loop wait (3 h); the project's own rounds and file locks above.
  fs.mkdirSync(path.join(ws, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.hive', 'workspace.json'), JSON.stringify({ loops: { waitHours: 3 } }))

  const { app, page } = await lib.launch({ userData, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const text = (loc) => loc.innerText().catch(() => '')
    await lib.openWorkspace(inv, page, ws)
    const wsJson = () => JSON.parse(fs.readFileSync(path.join(ws, '.hive', 'workspace.json'), 'utf8'))
    const shots = async (name, target) => {
      // The toasts of earlier saves dismissed, and the pointer off the rows.
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        if (target) await target.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(lib.WORK, `workflowdefaults-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const settingsSection = async (label) => {
      await page.keyboard.press('Control+,')
      const nav = page.locator('.settings-nav .row', { hasText: label }).first()
      await nav.waitFor({ timeout: HUNG_MS })
      await nav.click()
    }
    const startCard = async (title) => {
      const c = await inv('tasks:create', { title, project: 'alpha' })
      await inv('tasks:move', c.number, 'doing', { agent: 'b1' })
      const started = await lib.until(async () => (await inv('tasks:facts', c.number)).find((f) => f.kind === 'Started') ?? null, HUNG_MS)
      return started?.ruleset ?? null
    }
    const before = await startCard('Before the default')
    check('a card started before the change has its ruleset', !!before)
    // A running lane of alpha's, as the card-loop skill registers one (lanes.ts reads its table each time).
    const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { timeout: 5000 })
    try {
      const at = new Date().toISOString()
      const next = await inv('tasks:create', { title: 'Next in the lane', project: 'alpha' })
      db.prepare("INSERT INTO lanes (id, ord, project, builder_id, builder_name, reviewer_id, reviewer_name, rounds, wait_minutes, state, started_by, started_at, updated_at) VALUES ('lane-wd1', 0, 'alpha', 'b1', 'B1', 'r1', 'R1', 10, 360, 'active', 'B1 (alpha)', ?, ?)").run(at, at)
      db.prepare('INSERT INTO lane_cards (lane, ord, card) VALUES (?, 0, ?)').run('lane-wd1', next.number)
      db.prepare("UPDATE lanes SET name = 'Lane next' WHERE id = 'lane-wd1'").run()
    } finally {
      db.close()
    }

    // --- The workspace's defaults: Settings → Workspace → Workflow defaults, Git.
    await settingsSection('Workspace')
    const level = page.locator('.workflow-level[data-level="workspace"]')
    check('Settings → Workspace has the workspace’s workflow defaults, None · Git', !!(await lib.until(async () => (await level.count()) === 1 && (await level.locator('[data-platform="git"][aria-checked="true"]').count()) === 1, HUNG_MS)))
    const form = level.locator('.workflow-form')
    const row = (option) => form.locator(`.workflow-option[data-option="${option}"]`)
    check('the editor’s groups, Inherit relative to Hive’s level (every option Default here)', !!(await lib.until(async () => (await row('style').count()) === 1, HUNG_MS)) && (await row('style').innerText()).includes('Default') && (await form.locator('.workflow-group[data-group="elsewhere"]').count()) === 0)
    await row('style').locator('select').selectOption('squash')
    check('a value set at this level says so', (await row('style').innerText()).includes('Set here'))
    await form.locator('[data-action="save"]').click()
    const dialog = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    await dialog.waitFor({ timeout: HUNG_MS })
    const said = await text(dialog)
    check('Save… lists the project inheriting the change, and what changes for it', said.includes('Project alpha: Merge style') && said.includes('from their next card'), said)
    check('…and names alpha’s running lane and its card in flight, which keep the old rules', said.includes('Its running lane keeps the old rules until it ends:') && said.includes('Builder B1: Lane next') && said.includes('Its card in flight keeps the old rules:') && said.includes('Before the default'), said)
    await shots('save', dialog)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('saved in workspace.json', !!(await lib.until(async () => wsJson().workflow?.git?.style === 'squash', HUNG_MS)), JSON.stringify(wsJson().workflow))
    await shots('workspace', level.locator('.workflow-level-head'))

    // --- The project: inherits it, its origin the workspace; its next card starts under it.
    await page.keyboard.press('Escape')
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const project = page.locator('.workflow-form')
    const projectRow = (option) => project.locator(`.workflow-option[data-option="${option}"]`)
    check('the project shows the workspace’s value, From the workspace', !!(await lib.until(async () => (await projectRow('style').locator('select').inputValue().catch(() => '')) === 'squash' && (await projectRow('style').innerText()).includes('From the workspace'), HUNG_MS)), await text(projectRow('style')))
    // The settings from before HI-1766 kept, as options: the project's own rounds and file locks, the workspace's wait.
    const loopsOrigin = async (k) => projectRow(k).locator('.workflow-origin').innerText().catch(() => '')
    check('the project’s old rounds and file locks are its own options, the workspace’s old wait its default', (await projectRow('loopRounds').locator('input').inputValue()) === '8' && (await loopsOrigin('loopRounds')).includes('Set for this project') && (await projectRow('fileLocks').locator('select').inputValue()) === 'warn' && (await projectRow('loopWaitHours').locator('input').getAttribute('placeholder')) === '3 hours' && (await loopsOrigin('loopWaitHours')).includes('From the workspace'), JSON.stringify([await loopsOrigin('loopRounds'), await loopsOrigin('loopWaitHours')]))
    check('…and the old keys are gone from the files once saved', !('loops' in wsJson()))
    await shots('migrated', projectRow('loopRounds'))
    const after = await startCard('After the default')
    check('its next card starts under the new options (another ruleset)', !!after && after !== before, `${before} → ${after}`)
    check('the card started before keeps its ruleset', (await inv('tasks:facts', 1)).find((f) => f.kind === 'Started')?.ruleset === before)

    // --- A project's own value still wins.
    await projectRow('style').locator('select').selectOption('merge')
    await project.locator('[data-action="save"]').click()
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('the project’s own value wins: Merge commit, Set for this project', !!(await lib.until(async () => (await projectRow('style').locator('select').inputValue()) === 'merge' && (await projectRow('style').innerText()).includes('Set for this project'), HUNG_MS)))

    // --- Hive's defaults, under the workspace's: Settings → Workflow defaults.
    await settingsSection('Workflow defaults')
    const hive = page.locator('.workflow-level[data-level="global"]')
    const hiveRow = (option) => hive.locator(`.workflow-option[data-option="${option}"]`)
    check('Settings → Workflow defaults has Hive’s', !!(await lib.until(async () => (await hiveRow('dependenciesDone').count()) === 1, HUNG_MS)))
    await hiveRow('dependenciesDone').locator('[role="switch"], input[type="checkbox"]').first().click()
    await hive.locator('[data-action="save"]').click()
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    const form2 = await lib.until(async () => {
      const f = await inv('workflow:form', alpha)
      return f.origins.dependenciesDone === 'global' ? f : null
    }, HUNG_MS)
    check('the project inherits Hive’s default, under the workspace’s (style still its own)', !!form2 && form2.options.dependenciesDone === true && form2.origins.style === 'project', JSON.stringify(form2?.origins))
    await shots('hive', hive.locator('.workflow-level-head'))
    // Hive's files copied into new slots (HI-1765), with Git's options: the default, .env*, until set here.
    const hiveCopy = hive.locator('[data-slot-default="copy"][data-level="global"]')
    check('Hive’s level has the files copied into new slots, at the default, .env*', !!(await lib.until(async () => (await hiveCopy.locator('.workflow-origin').getAttribute('data-origin').catch(() => '')) === 'default' && (await text(hiveCopy)).includes('.env*'), HUNG_MS)), await text(hiveCopy))
    await shots('hive-copy', hiveCopy)
    // Changed elsewhere (the settings tool, another window) while open: the row follows (HR5's round 1), and so does the
    // workspace's, inheriting it, then its own changed elsewhere.
    const copyOf = async (l) => ({ origin: await l.locator('.workflow-origin').getAttribute('data-origin').catch(() => ''), field: await l.locator('textarea').inputValue().catch(() => ''), text: await text(l) })
    await inv('slots:setLevelDefault', 'global', 'copy', 'changed.env')
    check('…following a change made elsewhere while it is open', !!(await lib.until(async () => { const c = await copyOf(hiveCopy); return c.origin === 'here' && c.field === 'changed.env' }, HUNG_MS)), JSON.stringify(await copyOf(hiveCopy)))
    await page.locator('.settings-nav .row', { hasText: 'Workspace' }).first().click()
    const wsCopy = page.locator('[data-slot-default="copy"][data-level="workspace"]')
    check('the workspace’s copied files inherit it, From Hive’s settings', !!(await lib.until(async () => { const c = await copyOf(wsCopy); return c.origin === 'global' && c.text.includes('changed.env') }, HUNG_MS)), JSON.stringify(await copyOf(wsCopy)))
    await inv('slots:setLevelDefault', 'global', 'copy', 'again.env')
    check('…following Hive’s changing while it is open', !!(await lib.until(async () => { const c = await copyOf(wsCopy); return c.origin === 'global' && c.text.includes('again.env') }, HUNG_MS)), JSON.stringify(await copyOf(wsCopy)))
    await inv('slots:setLevelDefault', 'workspace', 'copy', 'ws.env')
    check('…and its own set elsewhere', !!(await lib.until(async () => { const c = await copyOf(wsCopy); return c.origin === 'here' && c.field === 'ws.env' }, HUNG_MS)), JSON.stringify(await copyOf(wsCopy)))
    // Focused but untouched (HR5's round 2): it takes a value changed elsewhere, and leaving it saves nothing. The next save
    // is made to fail (HIVE_TEST_FAIL_IPC, once): a save of the field's on leaving would take that; the probe's save after
    // it, from the same window, then fails only if the field sent none.
    const wsField = wsCopy.locator('textarea')
    await wsField.focus()
    await inv('slots:setLevelDefault', 'workspace', 'copy', 'ext.env')
    check('a focused, untouched field takes a value changed elsewhere', !!(await lib.until(async () => (await wsField.inputValue()) === 'ext.env', HUNG_MS)), await wsField.inputValue())
    await app.evaluate(() => {
      process.env.HIVE_TEST_FAIL_IPC = 'slots:setLevelDefault*1'
    })
    await wsCopy.locator('.s-title').click()
    const probe = await page.evaluate(() => window.hive.invoke('slots:setLevelDefault', 'workspace', 'copy', 'ext.env').then(() => 'saved', () => 'failed'))
    await app.evaluate(() => {
      delete process.env.HIVE_TEST_FAIL_IPC
    })
    check('…and leaving it saves nothing', probe === 'failed' && wsJson().slotDefaults?.copy === 'ext.env', `${probe} ${JSON.stringify(wsJson().slotDefaults)}`)
    // Typed in, then changed elsewhere: the typed text stays, and leaving saves it.
    await inv('slots:setLevelDefault', 'workspace', 'copy', null)
    check('the workspace’s copied files unset elsewhere inherit Hive’s again, the untouched field emptied', !!(await lib.until(async () => { const c = await copyOf(wsCopy); return c.origin === 'global' && c.text.includes('again.env') && c.field === '' }, HUNG_MS)), JSON.stringify(await copyOf(wsCopy)))
    await wsField.fill('mine.env')
    await inv('slots:setLevelDefault', 'workspace', 'copy', 'other.env')
    check('a field typed in keeps its text over a value changed elsewhere', !!(await lib.until(async () => (await copyOf(wsCopy)).origin === 'here', HUNG_MS)) && (await wsField.inputValue()) === 'mine.env', JSON.stringify(await copyOf(wsCopy)))
    await wsCopy.locator('.s-title').click()
    check('…and leaving saves it', !!(await lib.until(() => wsJson().slotDefaults?.copy === 'mine.env', HUNG_MS)), JSON.stringify(wsJson().slotDefaults))
    await inv('slots:setLevelDefault', 'workspace', 'copy', null)
    await inv('slots:setLevelDefault', 'global', 'copy', null)
    check('…and inherits the default again once both are unset', !!(await lib.until(async () => { const c = await copyOf(wsCopy); return c.origin === 'default' && c.text.includes('.env*') }, HUNG_MS)), JSON.stringify(await copyOf(wsCopy)))
    // The workspace's level shows Hive's as what it inherits.
    await page.locator('.settings-nav .row', { hasText: 'Workspace' }).first().click()
    check('the workspace’s level inherits it: From Hive’s settings', !!(await lib.until(async () => (await row('dependenciesDone').innerText().catch(() => '')).includes('From Hive’s settings'), HUNG_MS)))

    // --- A level that would make an inheriting project contradictory is refused, naming it.
    await inv('workflow:setOptions', alpha, { preset: null, options: { style: 'merge', finish: 'committed' } })
    await row('folder').locator('select').selectOption('slots')
    await form.locator('[data-action="save"]').click()
    const problems = form.locator('.workflow-problems')
    check('refused: alpha inherits it and would contradict, with the reason', !!(await lib.until(async () => (await text(problems)).includes('Project alpha inherits these options') && (await text(problems)).includes('needs everyone in the project folder'), HUNG_MS)), await text(problems))
    check('…nothing written', wsJson().workflow?.git?.folder === undefined)
    await shots('refused', problems)
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await page.screenshot({ path: path.join(lib.WORK, 'workflowdefaults-failed.png') }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
