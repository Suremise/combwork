// Agent names from patterns (#1440, SPEC §16.10.6), fake Claude Code, the Assistant off: two projects keyed AM
// (ambrosia) and AP (apiary) each load Combwork's Team 3×3 without a rename (AM-B1… and AP-B1…, Load template ready at
// once); ambrosia's agents saved as a template with "Use the project key in names" keep patterns ({key}-B{n}), and
// without it fixed names; the fixed-name one loaded into apiary has every name taken by ambrosia's, so free names are
// filled in (AP-B1…, the key swapped), one edited to a taken name greys Load template out until it is fixed; loaded,
// apiary's agents have apiary's names. Editing the pattern template's description only keeps its patterns and pairs (HR3,
// round 1), and it loads into apiary with apiary's names. Each row's partner ("with AP-R1") follows the names in the
// boxes, and the load pairs the agents under them. In German and Polish every column shows without scrolling sideways.
// Add Agent from Template asks for its name, filled in free. Screenshots of the names table with a clash in English and
// German, light and dark. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
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
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'templatenames-profile')
const ws = path.join(lib.WORK, 'templatenames-ws')
const claudeHome = path.join(lib.WORK, 'templatenames-claude-home')
const shots = path.join(lib.WORK, 'templatenames-shots')
const ambrosia = path.join(ws, 'ambrosia')
const apiary = path.join(ws, 'apiary')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  for (const p of [ambrosia, apiary]) {
    lib.gitProject(p)
    lib.git(p, ['branch', '-M', 'main'])
  }
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), ambrosia.toLowerCase(), apiary.toLowerCase()]))
  // Claude Code only: Codex stays off, so Combwork's templates' reviewers run on Claude Code (#1436).
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47801), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const agentsOf = (p) => JSON.parse(fs.readFileSync(path.join(p, '.combwork', 'project.json'), 'utf8')).agents ?? []
    const names = (p) => agentsOf(p).map((a) => a.name)
    const keys = async () => Object.fromEntries((await inv('project:keys')).map((k) => [path.basename(k.projectPath), k.key]))
    check('the projects have their keys: ambrosia AM, apiary AP', !!(await until(async () => JSON.stringify(await keys()) === JSON.stringify({ ambrosia: 'AM', apiary: 'AP' }), HUNG_MS)), JSON.stringify(await keys()))
    const select = async (name) => {
      // (Clicking Projects while it shows would hide the sidebar.)
      if ((await page.locator('.project-row', { hasText: name }).count()) === 0) await page.locator('.activity-btn[aria-label="Projects"]').click()
      await page.locator('.project-row', { hasText: name }).first().click()
      await until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === name, HUNG_MS)
    }
    const menuItem = (label) => page.locator('.menu .menu-item').filter({ has: page.getByText(label, { exact: true }) }).first()
    const openLoad = async (template) => {
      await lib.addMenuRun(page, 'Templates')
      await until(async () => (await menuItem(template).count()) === 1, HUNG_MS)
      await menuItem(template).click()
      const d = page.locator('.dialog', { hasText: `Load "${template}"?` })
      await until(async () => (await d.locator('.template-plan-name-input').count()) > 0, HUNG_MS)
      return d
    }
    const boxes = (d) => d.locator('.template-plan-name-input').evaluateAll((l) => l.map((x) => x.value))
    const partners = (d) => d.locator('.template-plan-table tbody tr[data-agent]').evaluateAll((l) => l.filter((r) => r.dataset.state !== 'removed').map((r) => r.querySelector('[data-paired-with]')?.getAttribute('data-paired-with') ?? null))
    // The plan made for the names in the boxes (asked for again as they change): its rows are those names.
    const settled = (d) => until(async () => JSON.stringify(await d.locator('.template-plan-table tbody tr[data-agent]:not([data-state="removed"])').evaluateAll((l) => l.map((r) => r.dataset.agent))) === JSON.stringify(await boxes(d)), HUNG_MS)
    // The table as wide as its box at most: nothing to scroll sideways to.
    const fits = (d) => d.evaluate((el) => { const t = el.querySelector('.template-plan-table'); const box = el.querySelector('.dialog-body'); return !!t && !!box && t.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1 && box.scrollWidth <= box.clientWidth + 1 })
    const loadButton = (d) => d.getByRole('button', { name: 'Load template' })
    const shoot = async (name, target) => {
      // No notice over the dialog (Template saved, from the edit above).
      const close = page.locator('.toast .icon-btn[aria-label="Dismiss"]')
      await until(async () => {
        if ((await close.count()) === 0) return true
        await close.first().click().catch(() => undefined)
        return false
      }, HUNG_MS)
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await target().screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    const team = ['B1', 'B2', 'B3', 'R1', 'R2', 'R3']

    // --- Combwork's Team 3×3 into each project: its key's names, nothing to rename, Load template ready at once.
    for (const [p, name, key] of [[ambrosia, 'ambrosia', 'AM'], [apiary, 'apiary', 'AP']]) {
      await select(name)
      const d = await openLoad('Team 3×3')
      const want = team.map((n) => `${key}-${n}`)
      check(`${name}: Team 3×3's names are ${key}-B1…, none marked, Load template ready`, JSON.stringify(await boxes(d)) === JSON.stringify(want) && (await d.locator('.template-plan-table .field-error').count()) === 0 && (await loadButton(d).isEnabled()), JSON.stringify(await boxes(d)))
      await agentsOnly(d)
      await loadButton(d).click()
      check(`${name}: loaded with those names`, !!(await until(async () => JSON.stringify(names(p)) === JSON.stringify(want), HUNG_MS)), JSON.stringify(names(p)))
    }

    // --- ambrosia saved as a template: with the key in names (offered, ticked), patterns; without, fixed names.
    await select('ambrosia')
    const save = async (name, patterns) => {
      await lib.addMenuRun(page, 'Templates')
      await until(async () => (await menuItem('Save Template…').count()) === 1, HUNG_MS)
      await menuItem('Save Template…').click()
      const d = page.locator('.dialog', { hasText: 'Save as template' })
      await until(async () => (await d.count()) === 1, HUNG_MS)
      const keyBox = d.locator('[data-check2] input')
      const offered = (await keyBox.count()) === 1 && (await keyBox.isChecked())
      await d.locator('input.input').fill(name)
      await d.locator('label.flex', { hasText: 'For every project' }).locator('input').check()
      if (!patterns) await keyBox.uncheck()
      await d.getByRole('button', { name: 'Save', exact: true }).click()
      await until(async () => (await d.count()) === 0, HUNG_MS)
      return offered
    }
    check('Save Template offers "Use the project key in names", ticked, for names that follow the key', await save('AM team', true))
    await save('AM fixed', false)
    const file = (f) => JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'templates', f), 'utf8'))
    check('…ticked: patterns, and the pairs by numbered name', !!(await until(async () => fs.existsSync(path.join(ws, '.combwork', 'templates', 'am-team.json')), HUNG_MS)) && JSON.stringify(file('am-team.json').agents.map((a) => a.name)) === JSON.stringify(['{key}-B{n}', '{key}-B{n}', '{key}-B{n}', '{key}-R{n}', '{key}-R{n}', '{key}-R{n}']) && file('am-team.json').pairs?.[0]?.builder === '{key}-B1', JSON.stringify(file('am-team.json').agents.map((a) => a.name)))
    // Written once the save is done (HI-1910: it reads the project's workflow first), never read before.
    check('…unticked: fixed names', !!(await until(async () => fs.existsSync(path.join(ws, '.combwork', 'templates', 'am-fixed.json')), HUNG_MS)) && JSON.stringify(file('am-fixed.json').agents.map((a) => a.name)) === JSON.stringify(team.map((n) => `AM-${n}`)))

    // --- The pattern template edited in the Templates view, its description only: shown with ambrosia's names, edited
    // as its patterns, saved with them and its pairs unchanged (HR3, #1440 round 1: the editor once saved the names shown).
    const patterns = JSON.stringify(file('am-team.json').agents.map((a) => a.name))
    const pairsBefore = JSON.stringify(file('am-team.json').pairs)
    await page.locator('.activitybar [aria-label="Templates"]').click()
    await page.locator('.sidebar .template-row:not([data-scope="hive"])[aria-label="AM team"]').first().click()
    const detail = page.locator('.main-area > .tab-body .template-detail')
    await until(async () => (await detail.count()) === 1, HUNG_MS)
    check("the view shows the pattern template with the selected project's names", !!(await until(async () => /AM-B1/.test(await detail.innerText().catch(() => '')) && !/\{key\}/.test(await detail.innerText().catch(() => '')), HUNG_MS)), await detail.innerText().catch(() => ''))
    await detail.getByRole('button', { name: 'Edit…' }).click()
    const editor = page.locator('.main-area > .tab-body .template-editor')
    await until(async () => (await editor.count()) === 1, HUNG_MS)
    const rows = () => editor.locator('tbody tr').evaluateAll((l) => l.map((r) => r.dataset.agent))
    check('…the editor has its patterns', JSON.stringify(await rows()) === patterns, JSON.stringify(await rows()))
    await editor.locator('#template-description').fill('Three builders, three reviewers.')
    await editor.getByRole('button', { name: 'Save Template' }).click()
    check('…saved with the description: its patterns and pairs as they were', !!(await until(async () => file('am-team.json').description === 'Three builders, three reviewers.', HUNG_MS)) && JSON.stringify(file('am-team.json').agents.map((a) => a.name)) === patterns && JSON.stringify(file('am-team.json').pairs) === pairsBefore, JSON.stringify(file('am-team.json')))

    // --- The fixed-name template into apiary: every name is ambrosia's, so free ones are filled in (AP-B1…).
    await select('apiary')
    let d = await openLoad('AM fixed')
    check('every name taken by ambrosia: free names filled in (the key swapped), none marked, Load template ready', JSON.stringify(await boxes(d)) === JSON.stringify(team.map((n) => `AP-${n}`)) && (await d.locator('.template-plan-table .field-error').count()) === 0 && (await loadButton(d).isEnabled()) && /Free names are filled in below/.test(await d.locator('[data-names-taken]').innerText()), JSON.stringify(await boxes(d)))
    // One edited to a name ambrosia has: marked, Load template greyed out; fixed, ready again.
    const second = d.locator('.template-plan-name-input').nth(1)
    await second.fill('AM-B2')
    check('a name edited to one ambrosia has is marked, and Load template greyed out', !!(await until(async () => JSON.stringify(await d.locator('.template-plan-table .field-error').allInnerTexts()) === '["ambrosia has an agent called AM-B2."]' && (await loadButton(d).isDisabled()), HUNG_MS)), JSON.stringify(await d.locator('.template-plan-table .field-error').allInnerTexts()))
    // Each partner by the name in its box (the Assistant, on round 2's screenshots): AP-B1 with AP-R1, AP-R2 with AM-B2 as typed.
    check('"with …" follows the names in the boxes', !!(await until(async () => JSON.stringify(await partners(d)) === JSON.stringify(['AP-R1', 'AP-R2', 'AP-R3', 'AP-B1', 'AM-B2', 'AP-B3']), HUNG_MS)), JSON.stringify(await partners(d)))
    check('English: every column shows, nothing to scroll sideways', !!(await settled(d)) && (await fits(d)))
    await shoot('names-clash-en', () => d)
    // The same in German and Polish (the dialog opened again, in that language: its text is set as it opens): every
    // column shows without scrolling sideways; German shot.
    await d.getByRole('button', { name: 'Cancel' }).click()
    const base = (await inv('app:info')).language
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
    for (const code of ['de', 'pl']) {
      const dir = path.join(lib.ROOT, 'locales', code)
      const messages = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
      await speak({ ...base, code, locale: code, messages })
      await until(async () => (await page.locator('.session-toolbar .add-menu').innerText().catch(() => '')).includes(messages['panes.add.menu']), HUNG_MS)
      await lib.addMenuRun(page, messages['panes.add.templates'])
      await until(async () => (await menuItem('AM fixed').count()) === 1, HUNG_MS)
      await menuItem('AM fixed').click()
      const there = page.locator('.dialog', { has: page.locator('.template-plan') }).last()
      await until(async () => (await there.locator('.template-plan-name-input').count()) === 6, HUNG_MS)
      await there.locator('.template-plan-name-input').nth(1).fill('AM-B2')
      check(`${code}: the clash marked`, !!(await until(async () => /AM-B2/.test(await there.locator('.template-plan-table .field-error').innerText().catch(() => '')), HUNG_MS)), await there.innerText().catch(() => ''))
      check(`${code}: every column shows, nothing to scroll sideways`, !!(await settled(there)) && (await fits(there)))
      if (code === 'de') {
        check('German: said in German', /eindeutig/.test(await there.innerText()))
        await shoot('names-clash-de', () => there)
      }
      await page.keyboard.press('Escape')
      await until(async () => (await there.count()) === 0, HUNG_MS)
    }
    await speak(base)
    await until(async () => (await page.locator('.session-toolbar .add-menu').innerText().catch(() => '')).includes('Add'), HUNG_MS)
    // Back in English: fixed, then loaded with apiary's names.
    d = await openLoad('AM fixed')
    await d.locator('.template-plan-name-input').nth(1).fill('AM-B2')
    await until(async () => await loadButton(d).isDisabled(), HUNG_MS)
    await d.locator('.template-plan-name-input').nth(1).fill('AP-B2')
    check('…fixed: Load template ready again', !!(await until(async () => (await d.locator('.template-plan-table .field-error').count()) === 0 && (await loadButton(d).isEnabled()), HUNG_MS)))
    await agentsOnly(d)
    await loadButton(d).click()
    check('loaded into apiary with its own names', !!(await until(async () => JSON.stringify(names(apiary)) === JSON.stringify(team.map((n) => `AP-${n}`)), HUNG_MS)), JSON.stringify(names(apiary)))
    check('…paired under those names', JSON.stringify(agentsOf(apiary).map((a) => a.pairedWith ?? null)) === JSON.stringify(['AP-R1', 'AP-R2', 'AP-R3', 'AP-B1', 'AP-B2', 'AP-B3']), JSON.stringify(agentsOf(apiary).map((a) => a.pairedWith ?? null)))
    // The edited pattern template into apiary: apiary's key, paired the same, Load template ready at once.
    d = await openLoad('AM team')
    check('the edited pattern template loads into apiary with its names', JSON.stringify(await boxes(d)) === JSON.stringify(team.map((n) => `AP-${n}`)) && (await loadButton(d).isEnabled()), JSON.stringify(await boxes(d)))
    await agentsOnly(d)
    await loadButton(d).click()
    check('…paired as saved', !!(await until(async () => JSON.stringify(agentsOf(apiary).map((a) => a.pairedWith ?? null)) === JSON.stringify(['AP-R1', 'AP-R2', 'AP-R3', 'AP-B1', 'AP-B2', 'AP-B3']), HUNG_MS)), JSON.stringify(agentsOf(apiary).map((a) => a.pairedWith ?? null)))

    // --- Add Agent from Template: its name asked for, filled in free (AM-B1 is ambrosia's: AP's taken too, so another).
    await lib.addMenuRun(page, 'Add Agent from Template')
    await until(async () => (await page.locator('.menu .menu-item').count()) > 3, HUNG_MS)
    const amFixed = page.locator('.menu .menu-header', { hasText: 'AM fixed' })
    await until(async () => (await amFixed.count()) === 1, HUNG_MS)
    await page.locator('.menu .menu-item').filter({ has: page.getByText('AM-B1', { exact: true }) }).last().click()
    const ask = page.locator('.dialog', { hasText: 'Add an agent from a template' })
    await until(async () => (await ask.count()) === 1, HUNG_MS)
    const box = ask.locator('#dialog-prompt-field')
    const filled = await box.inputValue()
    check('Add Agent from Template asks for its name, filled in free, with its role and coding agent', !['AM-B1', 'AP-B1'].includes(filled) && /Builder · suggests Claude Code/.test(await ask.innerText()), `${filled} | ${await ask.innerText()}`)
    await box.fill('AM-B1')
    await ask.getByRole('button', { name: 'Add Agent' }).click()
    check('…a name another agent has is refused there, naming whose', !!(await until(async () => /There is already an agent called "AM-B1" in ambrosia/.test(await ask.innerText().catch(() => '')), HUNG_MS)))
    await box.fill('Extra builder')
    await ask.getByRole('button', { name: 'Add Agent' }).click()
    check('…a free one is added', !!(await until(async () => names(apiary).includes('Extra builder'), HUNG_MS)), JSON.stringify(names(apiary)))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
