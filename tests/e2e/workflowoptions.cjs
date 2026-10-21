// Project Settings → Workflow (#1278): after an upgrade from 0.9 the one-time presets notice names the project, and
// Choose… opens its Workflow section; picking Pair (the agent merges) fills in its options (Pair and Team shown
// unavailable, with why), each with where its value comes from; Save… lists the running lane that keeps the old rules
// and saves; a contradiction is refused with its reason; Inherit goes back to the inherited value; Copy as JSON and Paste
// JSON… carry the options; with Workflow rules are enforced off the section says so. Screenshots in both themes and in
// Polish. Dev build, throwaway profile and workspace; no CLI is started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'workflowoptions-profile')
const ws = path.join(lib.WORK, 'workflowoptions-ws')
const project = path.join(ws, 'web')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Writes to the workspace's board from outside Hive, as another process would (the upgrade's marks, a lane's rows). */
function board(sql, ...args) {
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { timeout: 5000 })
  try {
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(project, { 'a.ts': 'export const a = 1\n', 'package.json': JSON.stringify({ name: 'web', scripts: { typecheck: 'tsc', lint: 'oxlint', test: 'vitest' } }) })
  // As the upgrade leaves a project: today's way of working (Not checked, a reviewer agent: it has one), no preset.
  fs.mkdirSync(path.join(project, '.hive'), { recursive: true })
  const upgraded = { review: 'agent', reviewers: 1, noSelfReview: true, preChecks: [], sameness: 'change', finish: 'notChecked', style: 'merge', target: '', strict: false, mergeChecks: [], okBefore: { mode: 'never', labels: [] }, folder: 'project', identity: null, stopOwnRuns: false, dependenciesDone: false, slotsUpToDate: false, sharedFolderWarning: false, excluded: ['node_modules', '.venv'], commands: {} }
  fs.writeFileSync(path.join(project, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1 (reviewer)' }], workflow: { platform: 'git', preset: null, options: upgraded } }))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 950 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    // A dialog or banner by itself; the section (taller than the window) as the window shows it, scrolled to `target`.
    const themes = async (name, target, scrollTo) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        if (scrollTo) await scrollTo.scrollIntoViewIfNeeded()
        await (scrollTo ? page : (target ?? page)).screenshot({ path: path.join(lib.WORK, `workflowoptions-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const projectJson = () => JSON.parse(fs.readFileSync(path.join(project, '.hive', 'project.json'), 'utf8'))

    // A board made by 1.0 has no notice; one upgraded from 0.9 (cards from before it) has, once.
    check('no presets notice on a board made by 1.0', (await inv('workflow:presetsNotice')) === null)
    const card = await inv('tasks:create', { title: 'Lane card', project: 'web' })
    board("INSERT INTO board_meta (key, value) VALUES ('adoption_upto', '7') ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    // A running lane of the project's, as the card-loop skill registers one (lanes.ts reads its table each time).
    const at = new Date().toISOString()
    board("INSERT INTO lanes (id, ord, project, builder_id, builder_name, reviewer_id, reviewer_name, rounds, wait_minutes, state, started_by, started_at, updated_at) VALUES ('lane-e2e1', 0, 'web', 'b1', 'B1', 'r1', 'R1 (reviewer)', 10, 360, 'active', 'B1 (web)', ?, ?)", at, at)
    board("INSERT INTO lane_cards (lane, ord, card) VALUES ('lane-e2e1', 0, ?)", card.number)
    await page.reload()
    await lib.appReady(page)
    const notice = page.locator('.presets-notice')
    check('after the upgrade, the presets notice names the project', !!(await lib.until(async () => (await notice.count()) > 0 && (await notice.innerText()).includes('web'), HUNG_MS)), await page.locator('.main-area').innerText().catch(() => ''))
    await themes('notice', notice)
    await notice.getByRole('button', { name: 'Choose…' }).click()
    const section = page.locator('.workflow-form')
    check('Choose… opens the project’s Workflow section', !!(await lib.until(async () => (await section.count()) > 0, HUNG_MS)))
    check('the notice is gone, and answered for good', !!(await lib.until(async () => (await notice.count()) === 0 && (await inv('workflow:presetsNotice')) === null, HUNG_MS)))

    // --- The form as the upgrade left it: no preset, each option with where its value comes from.
    const row = (option) => section.locator(`.workflow-option[data-option="${option}"]`)
    check('the version control is shown: Git', (await section.locator('.workflow-platform').innerText()).trim() === 'Git')
    check('no preset was chosen', (await section.locator('.workflow-preset select').inputValue()) === '')
    check('Pair and Team are listed unavailable, with why', (await section.locator('.workflow-unavailable').allInnerTexts()).join('\n').includes('Needs Hive to merge cards'))
    check('the upgrade’s options are the project’s own', (await row('finish').innerText()).includes('Set for this project'))
    check('Hive merges and later options are not shown', (await row('finish').locator('option').allInnerTexts()).every((t) => t !== 'Hive merges') && (await section.locator('.workflow-option[data-option="strict"]').count()) === 0)
    await themes('form', null, section.locator('.workflow-preset'))
    await themes('form-end', null, section.locator('.workflow-actions'))

    // --- Pick Pair (the agent merges): its options, the quick checks from the project's scripts.
    await section.locator('.workflow-preset select').selectOption('pairAgent')
    check('Pair (the agent merges): the agent merges', (await row('finish').locator('select').inputValue()) === 'agentMerges')
    check('…each card in its own folder (the builder’s worktree)', (await row('folder').locator('select').inputValue()) === 'slots' && (await row('folder').innerText()).includes('worktree'))
    const checkNames = await row('preChecks').locator('.workflow-check input').evaluateAll((els) => els.map((e) => e.value))
    check('…the quick checks from its scripts, with their commands', JSON.stringify(checkNames) === JSON.stringify(['typecheck', 'npm run typecheck', 'lint', 'npm run lint']), JSON.stringify(checkNames))
    check('…each from the preset', (await row('review').innerText()).includes('From the preset'))

    // --- Save…: what changes, the running lane that keeps the old rules; saved.
    await section.getByRole('button', { name: 'Save…' }).click()
    const dialog = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    await dialog.waitFor({ timeout: HUNG_MS })
    const said = await dialog.innerText()
    check('the warning says what changes', said.includes('Who merges') && said.includes('Where cards are built'), said)
    check('…and lists the running lane, which keeps the old rules', said.includes('keeps the old rules') && said.includes('Builder B1'), said)
    await themes('save', dialog)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('saved: Pair (the agent merges), in project.json', !!(await lib.until(async () => projectJson().workflow?.preset === 'pairAgent' && projectJson().workflow.options.finish === 'agentMerges', HUNG_MS)), JSON.stringify(projectJson().workflow))
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })

    // --- A contradiction is refused with its reason, nothing saved.
    await row('finish').locator('select').selectOption('committed')
    check('a changed option makes it Custom, started from the preset', (await section.locator('.workflow-preset select option[value=""]').innerText()).includes('started from Pair (the agent merges)'))
    await section.getByRole('button', { name: 'Save…' }).click()
    const problems = section.locator('.workflow-problems')
    check('a contradiction is refused with its reason', !!(await lib.until(async () => (await problems.count()) > 0 && (await problems.innerText()).includes('“Committed is done” needs everyone in the project folder.'), HUNG_MS)), await problems.innerText().catch(() => ''))
    await themes('refused', null, section.locator('.workflow-problems'))
    check('…and nothing was saved', projectJson().workflow.options.finish === 'agentMerges')
    await section.getByRole('button', { name: 'Discard Changes' }).click()

    // --- Inherit: an option the project sets goes back to the inherited value (the platform's: the default branch).
    await row('target').locator('input').fill('release')
    check('a value set here shows Inherit', (await row('target').getByRole('button', { name: 'Inherit' }).count()) === 1)
    await row('target').getByRole('button', { name: 'Inherit' }).click()
    check('…which goes back to the inherited value', (await row('target').locator('input').inputValue()) === '' && (await row('target').innerText()).includes('Default'))
    await row('style').locator('select').selectOption('squash')
    await row('style').getByRole('button', { name: 'Inherit' }).waitFor({ timeout: HUNG_MS })
    await section.getByRole('button', { name: 'Save…' }).click()
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('saved with the merge style set', !!(await lib.until(async () => projectJson().workflow?.options.style === 'squash', HUNG_MS)))
    await row('style').getByRole('button', { name: 'Inherit' }).click()
    await section.getByRole('button', { name: 'Save…' }).click()
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('an option inherited again is left out of project.json', !!(await lib.until(async () => !('style' in projectJson().workflow.options) && projectJson().workflow.options.finish === 'agentMerges', HUNG_MS)), JSON.stringify(projectJson().workflow.options))

    // --- Copy as JSON and Paste JSON… (the clipboard stubbed: never the real one).
    await page.evaluate(() => {
      window.__copied = null
      navigator.clipboard.writeText = async (t) => void (window.__copied = t)
    })
    await section.getByRole('button', { name: 'Copy as JSON' }).click()
    const copied = await lib.until(() => page.evaluate(() => window.__copied), HUNG_MS)
    const parsed = copied ? JSON.parse(copied) : null
    check('Copy as JSON gives the version control, the preset and every option', parsed?.platform === 'git' && parsed?.preset === 'pairAgent' && parsed?.options.finish === 'agentMerges' && 'style' in parsed.options, String(copied))
    await section.getByRole('button', { name: 'Paste JSON…' }).click()
    const paste = page.locator('.dialog', { hasText: 'Paste Workflow Options' })
    await paste.waitFor({ timeout: HUNG_MS })
    await paste.locator('textarea').fill(JSON.stringify({ ...parsed, options: { ...parsed.options, finish: 'committed' } }))
    await paste.getByRole('button', { name: 'Use These Options' }).click()
    check('a pasted contradiction is refused in the dialog, with its reason', !!(await lib.until(async () => (await paste.innerText()).includes('needs everyone in the project folder'), HUNG_MS)), await paste.innerText())
    // A failure stays in the dialog, its button now Try Again.
    await paste.locator('textarea').fill(JSON.stringify({ ...parsed, options: { ...parsed.options, target: 'release' } }))
    await paste.getByRole('button', { name: 'Try Again' }).click()
    await paste.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('a good paste fills the form, to save', (await row('target').locator('input').inputValue()) === 'release')
    await section.getByRole('button', { name: 'Discard Changes' }).click()

    // --- With the rules not enforced, the section says so.
    await inv('advanced:set', 'hive.workflow.enforce', false)
    await page.locator('.settings-nav .row', { hasText: 'Storage' }).click()
    await page.locator('.settings-nav .row', { hasText: 'Workflow' }).click()
    check('with Workflow rules are enforced off, the section says so', !!(await lib.until(async () => (await section.locator('.workflow-note').count()) > 0 && (await section.innerText()).includes('aren’t enforced'), HUNG_MS)))
    await inv('advanced:set', 'hive.workflow.enforce', null)

    // --- Another language: Polish.
    await inv('settings:update', { general: { language: 'pl' } })
    await page.locator('.settings-nav .row').nth(0).click()
    await page.locator('.settings-nav .row', { hasText: 'Przepływ pracy' }).click()
    check('the section shows in Polish', !!(await lib.until(async () => (await section.count()) > 0 && (await section.innerText()).includes('Kto scala'), HUNG_MS)), await section.innerText().catch(() => ''))
    await section.locator('.workflow-preset').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, 'workflowoptions-form-pl.png') })
    await inv('settings:update', { general: { language: 'en' } })
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nworkflowoptions: all checks passed')
  process.exit(failed ? 1 : 0)
})()
