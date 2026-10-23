// The Version Control tab's slot options (#1445, SPEC §16.6.2, §16.6.3, §16.6.6, §16.10): G11 as real slots, G15 and
// G17 offered, the presets at their full values, and the Slots and copies group. A Git project (alpha) with a builder
// and a reviewer, no agent started:
// - Pair chosen: G15 On and G17 One per lane in its preview, and saved; Team the same;
// - G11 = project folder hides G15 but shows G17, and A shared pool saves there; G1b = 2 with a pool saves;
// - the setup script set in Slots and copies is the one the next warming run uses (a marker file in the slot), and the
//   slots list shows the lent slot with its card; the copies' size saves; two fields saved while the first save is slow
//   (HIVE_TEST_SLOW_IPC) both stay, with another window's change; the setup emptied is "none", and Inherit undoes it;
// - Project Settings → Agents & Worktrees points to the group;
// - a project saved by a P6 build with Pair (G15 stored Off, the one-time step not run yet) reads as Pair, not Custom,
//   after the next start, with G15 On.
// Screenshots of the Slots and copies group and the G11/G15/G17 rows, light and dark, in English and German.
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const q = require('./queueFixture.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const PORT = Number(lib.port(47804))
const fx = q.queueProject('slotoptions')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const projectJson = (p = fx.alpha) => JSON.parse(fs.readFileSync(path.join(p, '.hive', 'project.json'), 'utf8'))
/** Changes the workspace's board from outside Hive, as another process would. */
function board(sql, ...args) {
  const db = new DatabaseSync(path.join(fx.ws, '.hive', 'hive.db'), { timeout: 5000 })
  try {
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

;(async () => {
  q.prepare(fx)
  // A second project, as a P6 build saved Pair (made before the restart below).
  const beta = path.join(fx.ws, 'beta')
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.hive/\n' })
  lib.git(beta, ['branch', '-M', 'main'])
  const marker = 'setup-marker.txt'
  let h = await q.startHive(fx, { port: PORT, keepOptions: true })
  let { page, inv, app } = h
  const shot = async (name, target) => {
    while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
    await page.mouse.move(5, 5)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      if (target) await target.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(fx.shots, `slotoptions-${name}-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 950 })
    const b1 = await lib.addAgent(inv, fx.alpha, { name: 'B1', workflowRole: 'builder' })
    await lib.addAgent(inv, fx.alpha, { name: 'R1', workflowRole: 'reviewer' })
    const section = page.locator('.workflow-form')
    const row = (option) => section.locator(`.workflow-option[data-option="${option}"]`)
    const choice = (id) => section.locator(`.workflow-choice[data-choice="${id}"]`)
    const preview = section.locator('.workflow-preview')
    const slotsGroup = section.locator('.workflow-group[data-group="slots"]')
    const dialog = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    // The project's Version Control tab at Workflow.
    const openWorkflow = async (p) => {
      await page.getByText(path.basename(p), { exact: true }).first().click()
      await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
      await page.locator('.git-sections [data-section="workflow"]').click()
      await section.waitFor({ timeout: HUNG_MS })
    }
    const saveAll = async () => {
      await section.locator('[data-action="save"]').click()
      await dialog.waitFor({ timeout: HUNG_MS })
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    }
    await openWorkflow(fx.alpha)

    // --- Pair and Team at their full values: G15 On, G17 One per lane, in the preview and saved.
    for (const id of ['pair', 'team']) {
      await choice(id).click()
      await preview.waitFor({ timeout: HUNG_MS })
      const g15 = await preview.locator('li[data-option="slotsUpToDate"]').innerText().catch(() => '')
      const g17 = await preview.locator('li[data-option="reviewerMode"]').innerText().catch(() => '')
      check(`${id}'s preview: G15 On, G17 One per lane, each with why`, g15.includes('Slots are brought up to date before each card: On') && g15.includes('no card is built on an old copy') && g17.includes('Reviewers: One per lane'), JSON.stringify({ g15, g17 }))
      if (id === 'pair') await shot('pair-preview', preview)
      await preview.locator('[data-action="use-choice"]').click()
      await preview.waitFor({ state: 'detached', timeout: HUNG_MS })
      await saveAll()
      check(`…${id} saved with them`, !!(await until(() => projectJson().workflow?.preset === id && projectJson().workflow.options.slotsUpToDate === true && projectJson().workflow.options.reviewerMode === 'lane', HUNG_MS)), JSON.stringify(projectJson().workflow))
    }
    check('G11 says what a slot is, and the old "builder’s worktree" line is gone', (await row('folder').innerText()).includes('a slot Hive lends to the card or its lane') && !(await row('folder').innerText()).includes('worktree'), await row('folder').innerText())
    check('G15 and G17 are shown, with slots and a reviewer agent', (await row('slotsUpToDate').count()) === 1 && (await row('reviewerMode').count()) === 1)
    await shot('rows-slots', row('folder'))

    // --- G11 = project folder: G15 hidden, G17 shown; a shared pool saves there; then G1b = 2 with it.
    await row('finish').locator('select').selectOption('notChecked')
    await row('folder').locator('select').selectOption('project')
    check('the project folder hides G15', !!(await until(async () => (await row('slotsUpToDate').count()) === 0, HUNG_MS)))
    check('…but shows G17', (await row('reviewerMode').count()) === 1)
    await row('reviewerMode').locator('select').selectOption('pool')
    check('…and nothing contradicts', (await section.locator('.workflow-contradiction').count()) === 0, await section.locator('.workflow-contradiction').allInnerTexts().then((t) => t.join(' | ')))
    await saveAll()
    check('A shared pool saves with everyone in the project folder', !!(await until(() => projectJson().workflow.options.reviewerMode === 'pool' && projectJson().workflow.options.folder === 'project', HUNG_MS)), JSON.stringify(projectJson().workflow.options))
    await shot('rows-project', row('reviewerMode'))
    await row('reviewers').locator('select').selectOption('2')
    await saveAll()
    check('G1b = 2 with G17 = pool saves, each its own', !!(await until(() => projectJson().workflow.options.reviewers === 2 && projectJson().workflow.options.reviewerMode === 'pool', HUNG_MS)), JSON.stringify(projectJson().workflow.options))

    // --- Slots and copies: back to slots; the setup script set here is the one the next warming runs.
    await row('folder').locator('select').selectOption('slots')
    await saveAll()
    check('Slots and copies shows the scripts with slots', !!(await until(async () => (await slotsGroup.locator('[data-slot-option="setup"]').count()) === 1, HUNG_MS)))
    check('…the setup script unset shows where its value comes from', (await slotsGroup.locator('[data-slot-option="setup"] .workflow-origin').getAttribute('data-origin')) === 'worktreeSetup')
    const setup = `node -e "require('fs').writeFileSync('${marker}', 'from the tab')"`
    const setupField = slotsGroup.locator('[data-slot-option="setup"] input')
    await setupField.fill(setup)
    await setupField.press('Enter')
    check('…saved as the project’s own slot setup', !!(await until(() => projectJson().slots?.setup === setup, HUNG_MS)), JSON.stringify(projectJson().slots))
    const card = (await inv('tasks:create', { title: 'Slot card', project: 'alpha' })).number
    const key = (await inv('tasks:list')).find((c) => c.number === card).key
    const lent = await inv('slots:test', fx.alpha, { op: 'lend', agent: b1.id, card })
    check('a card is lent a slot', lent?.ok === true, JSON.stringify(lent))
    const folder = lent?.slot?.folder
    check('…whose warming ran the tab’s setup script (its marker file in the slot)', !!(await until(() => folder && fs.existsSync(path.join(folder, marker)) && fs.readFileSync(path.join(folder, marker), 'utf8') === 'from the tab', HUNG_MS)), folder)
    // The list reads the slots as the group is shown: open the section again.
    await page.locator('.git-sections [data-section="changes"]').click().catch(() => {})
    await page.locator('.git-sections [data-section="workflow"]').click()
    const slotRow = slotsGroup.locator(`tr[data-slot="${lent?.slot?.name}"]`)
    check('the slots list shows the lent slot with its card', !!(await until(async () => (await slotRow.count()) === 1 && (await slotRow.innerText()).includes(key) && (await slotRow.innerText()).includes('B1'), HUNG_MS)), await slotsGroup.innerText().catch(() => ''))
    const size = slotsGroup.locator('[data-slot-option="copies"] input')
    await size.fill('3')
    await size.press('Enter')
    check('the copies’ size saves', !!(await until(() => projectJson().copies?.size === 3, HUNG_MS)), JSON.stringify(projectJson().copies))
    // Two fields changed while the first save is still on its way (HR5's round 1: the second save sent the slots as the
    // window last read them, losing the first): both stay, with the archive script another window set meanwhile.
    await app.evaluate(() => {
      process.env.HIVE_TEST_SLOW_IPC = 'slots:setSetting=2500*1'
    })
    const archiveField = slotsGroup.locator('[data-slot-option="archive"] input')
    const copyField = slotsGroup.locator('[data-slot-option="copy"] textarea')
    await archiveField.fill('echo archived')
    await archiveField.press('Enter')
    await inv('slots:setSetting', fx.alpha, 'setup', 'npm ci --other-window')
    await copyField.fill('.env.test')
    await copyField.blur()
    check('two fields saved at once both stay, with another window’s change', !!(await until(() => projectJson().slots?.archive === 'echo archived' && projectJson().slots?.copy === '.env.test' && projectJson().slots?.setup === 'npm ci --other-window', HUNG_MS)), JSON.stringify(projectJson().slots))
    await app.evaluate(() => {
      delete process.env.HIVE_TEST_SLOW_IPC
    })
    // Emptied, the setup script is this project's "none" over Agents & Worktrees' value; Inherit uses that again.
    await inv('project:updateConfig', fx.alpha, { worktreeSetup: 'npm ci --old' })
    const setupOrigin = slotsGroup.locator('[data-slot-option="setup"] .workflow-origin')
    await until(async () => (await setupField.inputValue()) === 'npm ci --other-window', HUNG_MS)
    await setupField.fill('')
    await setupField.press('Enter')
    check('emptied, the setup script is set to none, over the old setup', !!(await until(async () => projectJson().slots?.setup === '' && (await setupOrigin.getAttribute('data-origin')) === 'none', HUNG_MS)), JSON.stringify(projectJson().slots))
    await shot('slots-none', slotsGroup)
    await slotsGroup.locator('[data-action="inherit-setup"]').click()
    check('Inherit uses Agents & Worktrees’ setup again', !!(await until(async () => projectJson().slots && !('setup' in projectJson().slots) && (await setupOrigin.getAttribute('data-origin')) === 'worktreeSetup' && (await setupOrigin.innerText()).includes('npm ci --old'), HUNG_MS)), JSON.stringify(projectJson().slots))
    check('…with no Inherit button left', (await slotsGroup.locator('[data-action="inherit-setup"]').count()) === 0)
    check('Reviewers review in review copies shows Advanced’s switch', (await slotsGroup.locator('[data-slot-option="reviewCopies"] [data-value]').getAttribute('data-value')) === 'on')
    await shot('slots-group', slotsGroup)

    // --- Project Settings → Agents & Worktrees points to the group.
    await lib.openProjectSettings(page)
    check('Agents & Worktrees has a line with Open Version Control, not the setup and copy rows', !!(await until(async () => (await page.locator('[data-action="open-slot-options"]').count()) === 1, HUNG_MS)) && (await page.locator('.setting', { hasText: 'Setup command' }).count()) === 0)

    // --- German.
    const lang = (await inv('app:info')).language
    const speak = async (code) => {
      const dir = path.join(lib.ROOT, 'locales', code)
      const messages = code === 'en' ? null : Object.assign({}, ...fs.readdirSync(dir).filter((x) => x.endsWith('.json')).map((x) => JSON.parse(fs.readFileSync(path.join(dir, x), 'utf8'))))
      await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: messages ? { ...lang, code, locale: code, messages } : lang })
      return messages
    }
    await openWorkflow(fx.alpha)
    const de = await speak('de')
    check('the section shows in German', !!(await until(async () => (await section.innerText()).includes(de['workflow.slots.heading']), HUNG_MS)))
    await shot('slots-group-de', slotsGroup)
    await shot('rows-de', row('folder'))
    await speak('en')

    // --- A project a P6 build saved with Pair: G15 stored Off, and the one-time step not yet run.
    const pairOptions = (await inv('workflow:form', beta)).presets.find((p) => p.id === 'pair').options
    const { platform: _p, ...stored } = pairOptions
    const cfg = projectJson(beta)
    fs.writeFileSync(path.join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfg, workflow: { platform: 'git', preset: 'pair', options: { ...stored, slotsUpToDate: false } } }))
    await h.app.close()
    // As before P7: neither the step's mark nor the projects' own (the first start settled beta, with nothing to change).
    board("DELETE FROM board_meta WHERE key = 'workflow.slotsUpToDateFromBeforeP7' OR key LIKE 'workflow.slotsUpToDateFromBeforeP7:%'")
    h = await q.startHive(fx, { port: PORT, keepOptions: true })
    ;({ page, inv, app } = h)
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    check('after the next start, the P6 project’s Pair has G15 On', !!(await until(() => projectJson(beta).workflow.options.slotsUpToDate === true, HUNG_MS)), JSON.stringify(projectJson(beta).workflow))
    await lib.fitWindow(app, page, { width: 1400, height: 950 })
    // The new window's own locators (the first window's are gone with it).
    const form2 = page.locator('.workflow-form')
    await page.getByText('beta', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    await form2.waitFor({ timeout: HUNG_MS })
    check('…and reads as Pair, not Custom', !!(await until(async () => (await form2.locator('.workflow-preset-now').innerText()).trim() === 'Pair', HUNG_MS)), await form2.locator('.workflow-preset-now').innerText().catch(() => ''))
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
