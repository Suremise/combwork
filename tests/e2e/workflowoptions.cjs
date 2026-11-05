// The Version Control tab's Workflow section (#1418; P4's plain form #1278 before it): after an upgrade from 0.9 the
// one-time presets notice names the project, and Choose… opens its tab at Workflow. The options are in groups (Review,
// Checks, Merging, Where cards are built, Card loops, Stages; None: Review, Checks, The work, Card loops, Stages; File
// locks and Card loops options since HI-1766, File locks shown with slots too), each worded as an outcome with one sentence on what it does and where its value comes from. Each preset
// (and All off) previews what it sets and why, marking what it would change, before Use fills the form: Pair (the agent
// merges), Pair (Combwork merges, G9's checks and install), Team (#1361's note). A contradiction shows its reason under both
// rows as it is chosen and keeps Save off; those the form can't reach are refused when pasted, as a save is. Save… lists
// what changes and the running lane keeping the old rules; a stage rename alone applies now; a save after another change
// (the Assistant's tool, another window) is refused as changed meanwhile and the section reloads. Inherit, Copy as JSON
// and Paste JSON…, All off with what never turns off, and the rules not enforced. Options each saved alone from the
// window (#1483): a reviewer agent chosen from All off (#1508), G1b two reviewers, G12, G13, G14 on the project's own row; None's N1, N3, N4, N6. G4 set from the tab decides a clean
// rebase: Same change carries the pass over, Exact revision only makes it stale (S9). Screenshots in both themes, in
// German and in Polish. Dev build, throwaway profiles and workspaces; the fake Claude Code for G4's agents.
// Dev build only (#1578): it starts this checkout's Electron itself, writes the board's tables, and holds a read with a
// test seam (HIVE_TEST_SLOW_IPC); its queue's builders are on slots, as 1.0 has them.
const lib = require('./lib.cjs')
const q = require('./queueFixture.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'workflowoptions-profile')
const ws = path.join(lib.WORK, 'workflowoptions-ws')
const project = path.join(ws, 'web')
const notes = path.join(ws, 'notes')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Writes to the workspace's board from outside Combwork, as another process would (the upgrade's marks, a lane's rows). */
function board(sql, ...args) {
  const db = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { timeout: 5000 })
  try {
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

/** The form, its rows and its controls, in one window. */
async function theForm(page, app, inv) {
  const section = page.locator('.workflow-form')
  const row = (option) => section.locator(`.workflow-option[data-option="${option}"]`)
  const groups = () => section.locator('.workflow-group[data-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))
  const choice = (id) => section.locator(`.workflow-choice[data-choice="${id}"]`)
  const preview = section.locator('.workflow-preview')
  const save = section.locator('[data-action="save"]')
  const reasons = (option) => row(option).locator('.workflow-contradiction').evaluateAll((els) => els.map((e) => e.getAttribute('data-contradiction')))
  const values = (option) => row(option).locator('.workflow-check input').evaluateAll((els) => els.map((e) => e.value))
  const dialog = page.locator('.dialog', { hasText: 'Save Workflow Options' })
  /** Previews a choice and uses it. */
  const applyChoice = async (id) => {
    await choice(id).click()
    await preview.waitFor({ timeout: HUNG_MS })
    await preview.locator('[data-action="use-choice"]').click()
    await preview.waitFor({ state: 'detached', timeout: HUNG_MS })
  }
  /** Saves through the warning, waiting for it to close (it reloads the form as it ends). */
  const saveAll = async () => {
    await save.click()
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
  }
  /** Leaves the Workflow section and comes back to it: the form is read again. */
  const reopen = async () => {
    await page.locator('.git-sections [data-section="changes"]').click().catch(() => {})
    await page.locator('.git-sections [data-section="workflow"]').click()
    await section.waitFor({ timeout: HUNG_MS })
  }
  const discard = () => section.getByRole('button', { name: 'Discard Changes' }).click()
  // Earlier toasts dismissed first, and the pointer off the rows, so the shots show the rows (the Assistant's note on #1278).
  const clearToasts = async () => {
    while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
    await page.mouse.move(5, 5)
  }
  const themes = async (name, target) => {
    await clearToasts()
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      if (target) await target.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(lib.WORK, `workflowoptions-${name}-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  return { section, row, groups, choice, preview, save, reasons, values, dialog, applyChoice, saveAll, reopen, discard, clearToasts, themes, app, inv }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(project, { 'a.ts': 'export const a = 1\n', 'package.json': JSON.stringify({ name: 'web', scripts: { typecheck: 'tsc', lint: 'oxlint', test: 'vitest' } }) })
  // Its own commit identity: G12 shows it (never the machine's global one).
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.invalid']]) lib.git(project, ['config', k, v])
  // As the upgrade leaves a project: today's way of working (Not checked, a reviewer agent: it has one), no preset.
  fs.mkdirSync(path.join(project, '.combwork'), { recursive: true })
  const upgraded = { review: 'agent', reviewers: 1, noSelfReview: true, preChecks: [], sameness: 'change', finish: 'notChecked', style: 'merge', target: '', strict: false, mergeChecks: [], okBefore: { mode: 'never', labels: [] }, folder: 'project', identity: null, stopOwnRuns: false, dependenciesDone: false, slotsUpToDate: false, sharedFolderWarning: false, excluded: ['node_modules', '.venv'], commands: {} }
  fs.writeFileSync(path.join(project, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1 (reviewer)' }], workflow: { platform: 'git', preset: null, options: upgraded } }))
  // A project without version control, for None's groups and the contradictions only it can have.
  fs.mkdirSync(notes, { recursive: true })
  fs.writeFileSync(path.join(notes, 'README.md'), '# Notes\n')
  // Its preset chosen, so the presets notice names only web.
  fs.mkdirSync(path.join(notes, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(notes, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [], workflow: { platform: 'none', preset: 'solo', options: {} } }))
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
    const f = await theForm(page, app, inv)
    const { section, row, groups, choice, preview, save, reasons, values, dialog, applyChoice, saveAll, reopen, discard, themes } = f
    const projectJson = (p = project) => JSON.parse(fs.readFileSync(path.join(p, '.combwork', 'project.json'), 'utf8'))
    const saved = () => projectJson().workflow?.options ?? {}

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
    // Agents changing state replace the window's workspace each time; the notice reads main again only when what it
    // shows can change (HI-1807: a dozen agents working read it about once a second). Each call is counted in main.
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      const h = handlers.get('workflow:presetsNotice')
      globalThis.__presetsCalls = 0
      handlers.set('workflow:presetsNotice', (...x) => (globalThis.__presetsCalls++, h(...x)))
    })
    const status = (agentId, s) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'session-status', state: { provider: 'claude-code', runId: `wo-${agentId}`, projectPath: project, agentId, cwd: project, sessionId: '', status: s, runtime: { lifecycle: s === 'stopped' ? 'stopped' : 'running', maintenance: null, attention: null, composer: 'free' }, startedAt: new Date().toISOString(), launchSignature: '', unseen: false } })
    const running = page.locator('.project-row', { hasText: 'web' }).locator('.agent-count')
    for (const s of ['ready', 'working', 'waiting', 'working']) for (const a of ['b1', 'r1']) await status(a, s)
    // Main knows nothing of these made-up runs, so a workspace refresh meanwhile (a project.json write's) drops them: they
    // go on reporting, as running agents do, until the row shows them (HI-1774: it raced that refresh).
    const twoShown = !!(await lib.until(async () => {
      if ((await running.count()) === 1 && (await running.innerText()).trim() === '2') return true
      for (const a of ['b1', 'r1']) await status(a, 'working')
      return false
    }, HUNG_MS))
    for (const a of ['b1', 'r1']) await status(a, 'stopped')
    const noneShown = !!(await lib.until(async () => (await running.count()) === 0, HUNG_MS))
    const presetsCalls = await app.evaluate(() => globalThis.__presetsCalls)
    check('agents changing state don’t read the presets notice again, and it stays', twoShown && noneShown && presetsCalls === 0 && (await notice.count()) === 1, `two running shown: ${twoShown}, then none: ${noneShown}, calls: ${presetsCalls}`)
    // The answer's board write held a while, and the workspace changed meanwhile (#1464): the notice's reload then reads
    // the board before the answer is on it, and must not show it again.
    await app.evaluate(() => { process.env.HIVE_TEST_SLOW_IPC = 'workflow:presetsNoticeSaid=3000*1' })
    await notice.getByRole('button', { name: 'Choose…' }).click()
    await inv('workspace:refresh')
    const workflowTab = page.locator('.git-sections [data-section="workflow"]')
    check('Choose… opens the project’s Version Control tab at Workflow', !!(await lib.until(async () => (await section.count()) > 0 && (await workflowTab.getAttribute('aria-selected')) === 'true' && (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1, HUNG_MS)))
    // The sections are tabs (HI-1837): the arrows select and focus the next, its page the tab panel it labels; only the
    // selected one in the Tab order.
    const sectionTabs = page.locator('.git-sections[role="tablist"] [role="tab"]')
    const focusedSection = () => page.evaluate(() => document.activeElement?.getAttribute('data-section') ?? null)
    const panelFor = () => page.evaluate(() => { const b = document.querySelector('.git-body[role="tabpanel"]'); return b ? document.getElementById(b.getAttribute('aria-labelledby'))?.getAttribute('data-section') ?? null : null })
    await workflowTab.focus()
    await page.keyboard.press('ArrowRight')
    check('the sections are tabs: ArrowRight selects and focuses Changes, its page labelled by it', !!(await lib.until(async () => (await page.locator('.git-sections [aria-selected="true"]').getAttribute('data-section')) === 'changes' && (await focusedSection()) === 'changes' && (await panelFor()) === 'changes', HUNG_MS)), JSON.stringify([await focusedSection(), await panelFor()]))
    check('…only the selected section in the Tab order', JSON.stringify(await sectionTabs.evaluateAll((els) => els.filter((e) => e.tabIndex === 0).map((e) => e.getAttribute('data-section')))) === '["changes"]')
    await page.keyboard.press('ArrowLeft')
    // Its form read again (it remounts with the section), so the shots show it, not the page before its read answers.
    check('…ArrowLeft back to Workflow, its form shown again', !!(await lib.until(async () => (await workflowTab.getAttribute('aria-selected')) === 'true' && (await focusedSection()) === 'workflow' && (await panelFor()) === 'workflow' && (await section.locator('.workflow-group[data-group="review"]').isVisible().catch(() => false)), HUNG_MS)))
    await themes('section-tabs', page.locator('.git-head'))
    check('the notice is gone, and answered for good',!!(await lib.until(async () => (await notice.count()) === 0 && (await inv('workflow:presetsNotice')) === null, HUNG_MS)), `notice shown: ${await notice.count()}, presetsNotice: ${JSON.stringify(await inv('workflow:presetsNotice'))}`)
    await app.evaluate(() => { delete process.env.HIVE_TEST_SLOW_IPC })

    // --- The form as the upgrade left it: in groups, no preset, each option worded as an outcome with its origin.
    check('Git’s groups, in order', JSON.stringify(await groups()) === JSON.stringify(['presets', 'team', 'review', 'checks', 'merging', 'where', 'slots', 'loops', 'stages']), JSON.stringify(await groups()))
    const inGroup = async (g) => section.locator(`.workflow-group[data-group="${g}"] .workflow-option`).evaluateAll((els) => els.map((e) => e.getAttribute('data-option')))
    const layout = { review: await inGroup('review'), checks: await inGroup('checks'), merging: await inGroup('merging'), where: await inGroup('where'), loops: await inGroup('loops'), stages: await inGroup('stages') }
    check('each group has its options (G4 and G17 in Review, G17 with a reviewer agent; G9 and G8 hidden while the agent doesn’t merge through Combwork; G15 only with slots)', JSON.stringify(layout) === JSON.stringify({ review: ['review', 'reviewers', 'reviewerMode', 'noSelfReview', 'sameness', 'okBefore'], checks: ['preChecks'], merging: ['finish', 'style', 'target', 'dependenciesDone'], where: ['folder', 'identity', 'stopOwnRuns', 'sharedFolderWarning', 'fileLocks'], loops: ['loopWakes', 'loopRounds', 'loopWaitHours', 'loopStepWaitMinutes'], stages: ['stageNames'] }), JSON.stringify(layout))
    check('no Version control row: the header has the choice', (await section.locator('.workflow-platform').count()) === 0)
    check('no preset chosen', (await section.locator('.workflow-preset-now').innerText()).trim() === 'No preset chosen')
    check('every preset is offered, with All off', JSON.stringify(await section.locator('.workflow-choice').evaluateAll((els) => els.map((e) => e.getAttribute('data-choice')))) === JSON.stringify(['solo', 'pairAgent', 'pair', 'team', 'allOff']))
    check('the upgrade’s options are the project’s own', (await row('finish').innerText()).includes('Set for this project'))
    check('G1 in a shared folder reads “Work is reviewed before it’s done”', (await row('review').innerText()).startsWith('Work is reviewed before it’s done'), await row('review').innerText())
    check('G4 says what each value does', (await row('sameness').innerText()).includes('a pass carries over to a clean rebase or squash of the same change; with Exact revision only, any new revision makes it stale'), await row('sameness').innerText())
    check('the shared-folder warning shows with everyone in the project folder', (await row('sharedFolderWarning').count()) === 1)
    // Card loops (HI-1766): options of their own, from the defaults; File locks with them.
    check('Card loops: the defaults, Default as their origin', (await row('loopRounds').locator('input').getAttribute('placeholder')) === '10' && (await row('loopWaitHours').locator('input').getAttribute('placeholder')) === '6 hours' && (await row('loopStepWaitMinutes').locator('input').getAttribute('placeholder')) === '30 minutes' && (await row('loopRounds').locator('.workflow-origin').innerText()).includes('Default'), await section.locator('.workflow-group[data-group="loops"]').innerText())
    check('File locks: Block, with what it applies to', (await row('fileLocks').locator('select').inputValue()) === 'block' && (await row('fileLocks').locator('[data-note="file-locks"]').innerText()) === 'Applies to agents working in the same folder, outside a slot.')
    await themes('groups-top', section.locator('.workflow-group[data-group="review"]'))
    await themes('groups-end', section.locator('.workflow-group[data-group="loops"]'))

    // --- A preset's preview: what it sets and why, what it would change; Use fills the form.
    await choice('pairAgent').click()
    await preview.waitFor({ timeout: HUNG_MS })
    const lines = await preview.locator('li[data-option]').evaluateAll((els) => els.map((e) => e.getAttribute('data-option')))
    check('Pair (the agent merges)’s preview lists each option it sets, G4 included, each with why', lines.includes('sameness') && lines.includes('finish') && (await preview.locator('li[data-option="sameness"]').innerText()).includes('A clean rebase doesn’t change what was reviewed'), JSON.stringify(lines))
    check('…the options it would change marked, with their value now', (await preview.locator('li.changes[data-option="finish"]').innerText()).includes('Now: Not checked') && (await preview.locator('li.changes').count()) >= 3)
    check('…and the form is unchanged until Use', (await row('finish').locator('select').inputValue()) === 'notChecked')
    await themes('preview', preview)
    await preview.locator('[data-action="use-choice"]').click()
    check('Use: the agent merges', !!(await lib.until(async () => (await row('finish').locator('select').inputValue()) === 'agentMerges', HUNG_MS)))
    check('…each card in its own folder (a slot lent per card or lane), G1 read as before it’s merged', (await row('folder').locator('select').inputValue()) === 'slots' && (await row('folder').innerText()).includes('a slot Combwork lends to the card or its lane') && !(await row('folder').innerText()).includes('worktree') && (await row('review').innerText()).startsWith('Work is reviewed before it’s merged'))
    check('…the shared-folder warning not shown with each card in its own folder', (await row('sharedFolderWarning').count()) === 0)
    check('…no push after merging while the agent merges (G18: only the merge queue pushes)', (await row('pushTarget').count()) === 0)
    check('…the quick checks from its scripts, with their commands', JSON.stringify(await values('preChecks')) === JSON.stringify(['typecheck', 'npm run typecheck', 'lint', 'npm run lint']), JSON.stringify(await values('preChecks')))
    check('…each from the preset; the preset line names it', (await row('review').innerText()).includes('From the preset') && (await section.locator('.workflow-preset-now').innerText()).trim() === 'Pair (the agent merges)')
    check('…commits as the project’s own identity, shown', (await row('identity').innerText()).includes('Pat Builder <pat@example.invalid>'), await row('identity').innerText())

    // --- Save…: what changes, the running lane that keeps the old rules; saved through the one writer.
    await save.click()
    await dialog.waitFor({ timeout: HUNG_MS })
    const said = await dialog.innerText()
    check('the warning lists what changes, each option old → new, from the next card', said.includes('apply from the next card') && said.includes('Who merges: Not checked → The agent merges, Combwork checks') && said.includes('Where cards are built: Everyone in the project folder → Each card in its own folder'), said)
    check('…and lists the running lane, which keeps the old rules', said.includes('keeps the old rules') && said.includes('Builder B1'), said)
    await themes('save', dialog)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('saved: Pair (the agent merges), in project.json', !!(await lib.until(async () => projectJson().workflow?.preset === 'pairAgent' && saved().finish === 'agentMerges', HUNG_MS)), JSON.stringify(projectJson().workflow))
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })

    // --- Maximum agents (HI-2058): stepped with the arrow keys it is staged at once, before the box loses focus, so Save
    // lights and the row is marked; Discard drops it; typed and saved, it is the project's own. Pair's 2 again after.
    const maxBox = row('maxAgents').locator('input')
    const maxBefore = saved().maxAgents
    await maxBox.click()
    await maxBox.press('ArrowUp')
    check('Maximum agents stepped with ↑: Save lights and the row is marked while the box still has the focus', !!(await lib.until(async () => (await save.isEnabled()) && (await row('maxAgents').locator('.modified').count()) === 1, HUNG_MS)) && (await maxBox.evaluate((e) => e === document.activeElement)), await maxBox.inputValue())
    await discard()
    check('…Discard Changes drops it, nothing written', !!(await lib.until(async () => !(await save.isEnabled()) && (await maxBox.inputValue()) === String(maxBefore ?? ''), HUNG_MS)) && saved().maxAgents === maxBefore, JSON.stringify({ maxBefore, saved: saved().maxAgents }))
    await maxBox.fill('14')
    await lib.until(async () => save.isEnabled(), HUNG_MS)
    await saveAll()
    check('…typed and saved: the project’s own Maximum agents, in project.json', !!(await lib.until(async () => saved().maxAgents === 14, HUNG_MS)), JSON.stringify(saved()))
    await maxBox.fill(String(maxBefore))
    await lib.until(async () => save.isEnabled(), HUNG_MS)
    await saveAll()
    await lib.until(async () => saved().maxAgents === maxBefore, HUNG_MS)

    // --- Contradictions as you choose: the reason under both rows at once, Save off until it's resolved.
    const both = async (c, a, b) => JSON.stringify(await reasons(a)).includes(c) && JSON.stringify(await reasons(b)).includes(c)
    await row('finish').locator('select').selectOption('committed')
    check('Committed is done with each card in its own folder: the reason under Who merges and Where cards are built', !!(await lib.until(() => both('committedNeedsFolder', 'finish', 'folder'), HUNG_MS)) && (await row('folder').innerText()).includes('“Committed is done” needs everyone in the project folder.'))
    check('…and Save is off', await save.isDisabled())
    check('…the preset line says Custom, started from the preset', (await section.locator('.workflow-preset-now').innerText()).includes('started from Pair (the agent merges)'))
    await themes('contradiction', row('finish'))
    await row('folder').locator('select').selectOption('project')
    check('resolved: the reasons go, Save is on', !!(await lib.until(async () => (await reasons('finish')).length === 0 && (await reasons('folder')).length === 0 && (await save.isEnabled()), HUNG_MS)))
    await row('finish').locator('select').selectOption('hiveMerges')
    check('Combwork merges in the project folder: under both rows', !!(await lib.until(() => both('mergeNeedsSlots', 'finish', 'folder'), HUNG_MS)) && (await save.isDisabled()))
    await discard()
    await row('reviewers').locator('select').selectOption('2')
    await row('review').locator('select').selectOption('you')
    check('Two reviewers with you reviewing: under both rows', !!(await lib.until(() => both('quorumNeedsAgent', 'reviewers', 'review'), HUNG_MS)))
    await row('okBefore').locator('select').selectOption('every')
    check('Your OK before merging while you review: under both rows', !!(await lib.until(() => both('okWithReview', 'okBefore', 'review'), HUNG_MS)) && (await save.isDisabled()))
    await discard()
    check('Discard Changes clears them', !!(await lib.until(async () => (await section.locator('.workflow-contradiction').count()) === 0, HUNG_MS)))

    // --- Inherit: an option the project sets goes back to the inherited value (the platform's: the default branch).
    await row('target').locator('input').fill('release')
    await row('target').locator('input').blur()
    check('a value set here shows Inherit', (await row('target').getByRole('button', { name: 'Inherit' }).count()) === 1)
    await row('target').getByRole('button', { name: 'Inherit' }).click()
    check('…which goes back to the inherited value', (await row('target').locator('input').inputValue()) === '' && (await row('target').innerText()).includes('Default'))
    await row('style').locator('select').selectOption('squash')
    await saveAll()
    check('saved with the merge style set', !!(await lib.until(async () => saved().style === 'squash', HUNG_MS)))
    await row('style').getByRole('button', { name: 'Inherit' }).click()
    await saveAll()
    check('an option inherited again is left out of project.json', !!(await lib.until(async () => !('style' in saved()) && saved().finish === 'agentMerges', HUNG_MS)), JSON.stringify(saved()))

    // --- Typed as a person types (HR6's round 1): Your OK's labels and a check's command keep their spaces.
    const okSelect = row('okBefore').locator('select')
    await okSelect.selectOption('labels')
    await row('okBefore').locator('input').pressSequentially('ui, release')
    await row('preChecks').getByRole('button', { name: 'Add Check' }).click()
    const newCheck = row('preChecks').locator('.workflow-check').last()
    await newCheck.locator('input').first().fill('')
    await newCheck.locator('input').first().pressSequentially('unit tests')
    await newCheck.locator('input').nth(1).pressSequentially('npm run test -- --silent')
    await saveAll()
    check('saved: the labels policy and the check with its command', !!(await lib.until(async () => saved().okBefore?.mode === 'labels' && saved().commands?.['unit tests'] === 'npm run test -- --silent', HUNG_MS)), JSON.stringify(saved()))
    await reopen()
    check('opened again: the labels and the check’s command', !!(await lib.until(async () => (await okSelect.inputValue()) === 'labels' && (await row('okBefore').locator('input').inputValue()) === 'ui, release' && (await values('preChecks')).includes('npm run test -- --silent'), HUNG_MS)))

    // --- Copy as JSON and Paste JSON… (the clipboard stubbed: never the real one); a paste is checked as a save is.
    await page.evaluate(() => {
      window.__copied = null
      navigator.clipboard.writeText = async (t) => void (window.__copied = t)
    })
    await section.getByRole('button', { name: 'Copy as JSON' }).click()
    const copied = await lib.until(() => page.evaluate(() => window.__copied), HUNG_MS)
    const parsed = copied ? JSON.parse(copied) : null
    check('Copy as JSON gives the version control, the preset and every option', parsed?.platform === 'git' && parsed?.preset === 'pairAgent' && parsed?.options.finish === 'agentMerges' && 'style' in parsed.options, String(copied))
    const pasteIn = async (json) => {
      await section.getByRole('button', { name: 'Paste JSON…' }).click()
      const d = page.locator('.dialog', { hasText: 'Paste Workflow Options' })
      await d.waitFor({ timeout: HUNG_MS })
      await d.locator('textarea').fill(JSON.stringify(json))
      await d.getByRole('button', { name: 'Use These Options' }).click()
      return d
    }
    // The contradiction the form can't reach (its switch is held on while a reviewer agent checks): refused when pasted.
    const selfReview = await pasteIn({ ...parsed, options: { ...parsed.options, noSelfReview: false } })
    check('a pasted contradiction the form can’t reach is refused in the dialog, with its reason', !!(await lib.until(async () => (await selfReview.innerText()).includes('be off while a reviewer agent checks the work'), HUNG_MS)), await selfReview.innerText())
    await selfReview.locator('textarea').fill(JSON.stringify({ ...parsed, options: { ...parsed.options, target: 'release' } }))
    await selfReview.getByRole('button', { name: 'Try Again' }).click()
    await selfReview.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('a good paste fills the form, to save', (await row('target').locator('input').inputValue()) === 'release')
    await discard()

    // --- Pair (Combwork merges, #1355): Combwork merges, G9's checks suggested from the scripts with their commands, the install.
    await applyChoice('pair')
    check('Pair: Combwork merges into the repository’s own default branch, by name (master here)', (await row('finish').locator('select').inputValue()) === 'hiveMerges' && (await row('target').locator('input').inputValue()) === 'master', await row('target').locator('input').inputValue())
    check('…G9 in Checks: the quick checks from its scripts, with their commands', JSON.stringify(await inGroup('checks')) === JSON.stringify(['preChecks', 'mergeChecks', 'focusedTests', 'mergeInstall']) && JSON.stringify(await values('mergeChecks')) === JSON.stringify(['typecheck', 'npm run typecheck', 'lint', 'npm run lint']), JSON.stringify(await values('mergeChecks')))
    check('…G8 shown in Merging while Combwork merges', (await inGroup('merging')).includes('strict'))
    // G18 (#1179): pushing the target after a merge, shown while Combwork merges, off in the preset; switched on and saved.
    const push = row('pushTarget').locator('[role="switch"]')
    check('…G18 shown in Merging while Combwork merges, off', (await inGroup('merging')).includes('pushTarget') && (await push.getAttribute('aria-checked')) === 'false')
    await push.click()
    await themes('push', row('pushTarget'))
    // G6's third value (#1184): offered by name, chosen, and saved below.
    const styles = await row('style').locator('select option').allInnerTexts()
    check('…G6 offers Merge commit, Squash and Rebase and fast-forward', JSON.stringify(styles) === JSON.stringify(['Merge commit', 'Squash', 'Rebase and fast-forward']), JSON.stringify(styles))
    await row('style').locator('select').selectOption('rebase')
    await themes('rebase', row('style'))
    await themes('hivemerges', row('mergeChecks'))
    // File locks (HI-1766) stays with each card in a slot: agents can still share the project folder outside one.
    check('File locks is shown with slots too, saying where it applies', (await row('folder').locator('select').inputValue()) === 'slots' && (await row('fileLocks').locator('[data-note="file-locks"]').count()) === 1)
    await themes('filelocks-slots', row('fileLocks'))
    await row('mergeInstall').locator('select').selectOption('always')
    await saveAll()
    check('saved: Combwork merges, the merge checks, the install and the push after merging, in project.json', !!(await lib.until(async () => saved().finish === 'hiveMerges' && JSON.stringify(saved().mergeChecks) === JSON.stringify(['typecheck', 'lint']) && saved().mergeInstall === 'always' && saved().pushTarget === true && saved().style === 'rebase', HUNG_MS)), JSON.stringify(saved()))
    for (let i = (await row('mergeChecks').locator('.workflow-check').count()) - 1; i >= 0; i--) await row('mergeChecks').locator('.workflow-check').nth(i).getByRole('button', { name: 'Remove' }).click()
    check('with no merge checks, the install row is not shown', !!(await lib.until(async () => (await row('mergeInstall').count()) === 0, HUNG_MS)))
    await discard()

    // --- Team (#1361): Pair plus the unit tests before review and on the merged result, a clean install every time,
    // your OK for ui and release; each card's focused tests (G20, HI-1367) only with the project's runner, which this one
    // hasn't: off, its note saying where to set it.
    const note = section.locator('.workflow-preset-note')
    await applyChoice('team')
    check('Team: its note says where to set the command that runs each card’s focused tests', !!(await lib.until(async () => (await note.count()) === 1 && (await note.innerText()).includes('Each card’s focused tests'), HUNG_MS)))
    check('…G20 off with no runner', (await row('focusedTests').locator('[role="switch"]').getAttribute('aria-checked')) === 'false')
    await row('focusedTests').locator('[role="switch"]').click()
    check('…switched on: its two commands to fill in, and why it can’t be saved without the runner', !!(await lib.until(async () => (await row('focusedTests').locator('input').count()) === 2 && (await row('focusedTests').innerText()).includes('need the command that runs them'), HUNG_MS)), await row('focusedTests').innerText())
    await themes('focused', row('focusedTests'))
    await row('focusedTests').locator('[role="switch"]').click()
    const teamChecks = JSON.stringify(['typecheck', 'npm run typecheck', 'lint', 'npm run lint', 'test', 'npm test'])
    check('…quick checks + unit tests before review and on the merged result', JSON.stringify(await values('preChecks')) === teamChecks && JSON.stringify(await values('mergeChecks')) === teamChecks)
    check('…installed from scratch before every merge, your OK for ui or release', (await row('mergeInstall').locator('select').inputValue()) === 'always' && (await row('okBefore').locator('input').inputValue()) === 'ui, release')
    await themes('team', section.locator('.workflow-group[data-group="presets"]'))
    await saveAll()
    check('saved: Team, in project.json', !!(await lib.until(async () => projectJson().workflow?.preset === 'team' && saved().okBefore?.mode === 'labels', HUNG_MS)), JSON.stringify(projectJson().workflow))

    // --- Stage names (N5): a rename alone applies now, never "old rules".
    const stageBox = (stage) => row('stageNames').locator(`input[aria-label="Name of the stage ${stage}"]`)
    check('Stage names: a box per stage these options produce, its default name as the placeholder', (await stageBox('Review').getAttribute('placeholder')) === 'Review' && (await stageBox('Merging').count()) === 1, await row('stageNames').innerText())
    await stageBox('Review').fill('Checking')
    await stageBox('Review').blur()
    await save.click()
    await dialog.waitFor({ timeout: HUNG_MS })
    const renameSaid = await dialog.innerText()
    check('a rename alone: the warning says it applies now, and lists no lane keeping old rules', renameSaid.includes('names aren’t rules, so they apply now') && !renameSaid.includes('keeps the old rules'), renameSaid)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('saved: the name, the preset kept (names aren’t rules)', !!(await lib.until(async () => saved().stageNames?.review === 'Checking' && projectJson().workflow.preset === 'team', HUNG_MS)), JSON.stringify(projectJson().workflow))
    await stageBox('Merging').fill('Checking')
    await stageBox('Merging').blur()
    check('a duplicate name: its reason under the row, Save off', !!(await lib.until(async () => (await row('stageNames').locator('[data-stage-problem]').count()) > 0 && (await save.isDisabled()), HUNG_MS)), await row('stageNames').innerText())
    await discard()

    // --- A save after another change (the Assistant's settings tool, another window) is refused and the form reloads.
    await row('style').locator('select').selectOption('squash')
    // Another window's save, as main takes it (no base: the tool's way).
    await inv('workflow:setOptions', project, { preset: 'team', options: { ...saved(), target: 'release' } })
    await save.click()
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('the stale save is refused, said, and the section reloads to what is saved now', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'changed meanwhile' }).count()) > 0 && (await row('target').locator('input').inputValue()) === 'release' && (await row('style').locator('select').inputValue()) === 'merge', HUNG_MS)))
    check('…nothing written over it', saved().target === 'release' && saved().style !== 'squash', JSON.stringify(saved()))
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS }).catch(() => {})

    // --- All off (§16.6.4): chosen and saved; the section says what never turns off.
    await choice('allOff').click()
    await preview.waitFor({ timeout: HUNG_MS })
    check('All off’s preview lists what never turns off', (await preview.locator('[data-never-off]').innerText()).includes('index.lock'))
    await themes('alloff', preview)
    await preview.locator('[data-action="use-choice"]').click()
    check('All off: no review, not checked, the project folder, no checks; the never-off note shown', !!(await lib.until(async () => (await row('review').locator('select').inputValue()) === 'none' && (await row('finish').locator('select').inputValue()) === 'notChecked' && (await row('folder').locator('select').inputValue()) === 'project' && (await values('preChecks')).length === 0 && (await section.locator('.workflow-form > [data-never-off], [data-never-off]').count()) >= 1, HUNG_MS)))
    await saveAll()
    check('saved: every rule off, no preset; the stage name kept', !!(await lib.until(async () => projectJson().workflow?.preset === null && saved().review === 'none' && saved().finish === 'notChecked' && saved().folder === 'project' && saved().stageNames?.review === 'Checking', HUNG_MS)), JSON.stringify(projectJson().workflow))

    // --- With the rules not enforced, the section says so and still saves.
    await inv('advanced:set', 'cw.workflow.enforce', false)
    await reopen()
    check('with Workflow rules are enforced off, the section says so', !!(await lib.until(async () => (await section.locator('.workflow-note').count()) > 0 && (await section.innerText()).includes('aren’t enforced'), HUNG_MS)))
    await row('style').locator('select').selectOption('squash')
    await saveAll()
    check('…and still saves', !!(await lib.until(async () => saved().style === 'squash', HUNG_MS)))
    await inv('advanced:set', 'cw.workflow.enforce', null)

    // --- A reviewer agent chosen from All off (#1508): "Nobody reviews their own work", held on while one reviews, is
    // turned on in the draft too, so it saves, the warning listing both.
    if (await section.getByRole('button', { name: 'Discard Changes' }).isEnabled()) await discard()
    const switchOf = (option) => row(option).locator('[role="switch"]')
    const switchedOn = async (option) => (await switchOf(option).getAttribute('aria-checked')) === 'true'
    check('#1508: from All off, nobody-reviews-their-own-work saved off', saved().review === 'none' && saved().noSelfReview === false, JSON.stringify(saved()))
    await row('review').locator('select').selectOption('agent')
    check('#1508: a reviewer agent chosen, the switch held on, no contradiction shown, Save on', !!(await lib.until(async () => (await switchedOn('noSelfReview')) && (await section.locator('.workflow-contradiction').count()) === 0 && (await save.isEnabled()), HUNG_MS)))
    await themes('reviewer-from-alloff', row('noSelfReview'))
    await save.click()
    await dialog.waitFor({ timeout: HUNG_MS })
    const said1508 = await dialog.innerText()
    check('#1508: …the warning lists both changes', said1508.includes('Work is reviewed before it’s done: No review → A reviewer agent') && said1508.includes('Nobody reviews their own work: Off → On'), said1508)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('#1508: saved, a reviewer agent and nobody reviews their own work, one reviewer', !!(await lib.until(() => saved().review === 'agent' && saved().noSelfReview === true && (saved().reviewers ?? 1) === 1, HUNG_MS)), JSON.stringify(projectJson().workflow))

    // --- Set in the window on their own and saved (#1483), each before only by a preset or at Combwork's level: G1b two
    // reviewers, G12 the project's identity, G13 stop own runs, G14 on the project's own row. From the reviewer agent
    // just saved.
    const without = (o, key) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== key).sort(([a], [b]) => a.localeCompare(b))))
    /**
     * Switches one option in the form and saves it alone: project.json has the switched value (`value(on)`), and no
     * other option changed.
     */
    const switchAlone = async (opts, option, value) => {
      const before = opts()
      const was = await switchedOn(option)
      await switchOf(option).click()
      await saveAll()
      const want = JSON.stringify(value(!was))
      const ok = await lib.until(() => JSON.stringify(opts()[option] ?? null) === want && without(opts(), option) === without(before, option), HUNG_MS)
      return { ok: !!ok, now: !was, said: JSON.stringify({ was, want: value(!was), now: opts() }) }
    }
    const before1b = saved()
    await row('reviewers').locator('select').selectOption('2')
    await saveAll()
    check('G1b: two reviewers chosen in the window alone, saved', !!(await lib.until(() => saved().reviewers === 2 && without(saved(), 'reviewers') === without(before1b, 'reviewers'), HUNG_MS)), JSON.stringify(saved()))
    const g12 = await switchAlone(saved, 'identity', (v) => (v ? { name: 'Pat Builder', email: 'pat@example.invalid' } : null))
    check('G12: the project’s identity switched alone, saved (on: its name and email)', g12.ok, g12.said)
    const g13 = await switchAlone(saved, 'stopOwnRuns', (v) => v)
    check('G13: stop own runs switched alone, saved', g13.ok, g13.said)
    const g14 = await switchAlone(saved, 'dependenciesDone', (v) => v)
    check('G14: dependencies done switched on the project’s own row, saved', g14.ok, g14.said)
    await reopen()
    const shownNow = async () => ({ reviewers: await row('reviewers').locator('select').inputValue().catch(() => null), identity: await switchedOn('identity').catch(() => null), stopOwnRuns: await switchedOn('stopOwnRuns').catch(() => null), dependenciesDone: await switchedOn('dependenciesDone').catch(() => null) })
    const savedShown = JSON.stringify({ reviewers: '2', identity: g12.now, stopOwnRuns: g13.now, dependenciesDone: g14.now })
    check('…opened again: two reviewers, and each switch as saved', !!(await lib.until(async () => JSON.stringify(await shownNow()) === savedShown, HUNG_MS)), JSON.stringify({ shown: await shownNow(), saved: savedShown }))

    // --- None (no version control): its groups, and the contradictions only its options could have, refused when pasted.
    await page.getByText('notes', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await workflowTab.click()
    check('None’s groups, in order', !!(await lib.until(async () => JSON.stringify(await groups()) === JSON.stringify(['presets', 'team', 'review', 'checks', 'work', 'loops', 'stages']), HUNG_MS)), JSON.stringify(await groups()))
    const noneLayout = { review: await inGroup('review'), checks: await inGroup('checks'), work: await inGroup('work') }
    check('…N1, N2 in Review, N3 in Checks, N4, N6 and N7 (File locks) in The work', JSON.stringify(noneLayout) === JSON.stringify({ review: ['review', 'noSelfReview'], checks: ['preChecks'], work: ['excluded', 'dependenciesDone', 'fileLocks'] }), JSON.stringify(noneLayout))
    check('…and Card loops, as Git’s', JSON.stringify(await inGroup('loops')) === JSON.stringify(['loopWakes', 'loopRounds', 'loopWaitHours', 'loopStepWaitMinutes']))
    check('…N1 reads “Who checks the work before it’s done”', (await row('review').innerText()).startsWith('Who checks the work before it’s done'))
    await themes('none', section.locator('.workflow-group[data-group="review"]'))
    check('…its Card loops from the defaults, Default as their origin', (await row('loopWakes').locator('.workflow-origin').innerText()).includes('Default') && (await row('fileLocks').locator('.workflow-origin').innerText()).includes('Default'))
    await themes('none-loops', section.locator('.workflow-group[data-group="loops"]'))
    const noneBase = { hiveWorkflow: 1, platform: 'none', preset: null, options: {} }
    const merging = await pasteIn({ ...noneBase, options: { finish: 'hiveMerges' } })
    check('None: a merge pasted is refused, merging needs Git', !!(await lib.until(async () => (await merging.innerText()).includes('Merging needs Git'), HUNG_MS)), await merging.innerText())
    await merging.locator('textarea').fill(JSON.stringify({ ...noneBase, options: { folder: 'slots' } }))
    await merging.getByRole('button', { name: 'Try Again' }).click()
    check('None: a folder per card pasted is refused, everyone works in the project folder', !!(await lib.until(async () => (await merging.innerText()).includes('everyone works in the project folder'), HUNG_MS)), await merging.innerText())
    await merging.getByRole('button', { name: 'Cancel' }).click()

    // --- None's form (#1483): N1, N3, N4 and N6 chosen on it and saved, each on its own.
    const noneSaved = () => projectJson(notes).workflow?.options ?? {}
    await row('review').locator('select').selectOption('you')
    await saveAll()
    check('N1: You chosen on None’s form, saved', !!(await lib.until(() => noneSaved().review === 'you', HUNG_MS)), JSON.stringify(noneSaved()))
    await row('preChecks').getByRole('button', { name: 'Add Check' }).click()
    const noneCheck = row('preChecks').locator('.workflow-check').last()
    await noneCheck.locator('input').first().fill('')
    await noneCheck.locator('input').first().pressSequentially('spelling')
    await noneCheck.locator('input').nth(1).pressSequentially('npm run spell')
    await saveAll()
    check('N3: a check added on None’s form, saved with its command', !!(await lib.until(() => JSON.stringify(noneSaved().preChecks) === JSON.stringify(['spelling']) && noneSaved().commands?.spelling === 'npm run spell', HUNG_MS)), JSON.stringify(noneSaved()))
    await row('excluded').locator('input').fill('node_modules, .venv, build')
    await row('excluded').locator('input').blur()
    await saveAll()
    check('N4: a folder left out of the work on None’s form, saved', !!(await lib.until(() => JSON.stringify(noneSaved().excluded) === JSON.stringify(['node_modules', '.venv', 'build']), HUNG_MS)), JSON.stringify(noneSaved()))
    const n6 = await switchAlone(noneSaved, 'dependenciesDone', (v) => v)
    check('N6: dependencies done switched on None’s form alone, saved', n6.ok, n6.said)
    // notes as it was (Solo, nothing of its own), which the late reads below start from; the form reads it again.
    await inv('workflow:setOptions', notes, { preset: 'solo', options: {} })
    await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'workflow-changed', workspacePath: ws, projectPath: notes })
    check('notes back to Solo, the form with it', !!(await lib.until(async () => projectJson(notes).workflow?.preset === 'solo' && (await row('review').locator('select').inputValue()) === 'none' && (await row('excluded').locator('input').inputValue()) === 'node_modules, .venv', HUNG_MS)), JSON.stringify(projectJson(notes).workflow))

    // --- Reads answering late (HR5's round 1): a reload never replaces an edit made while it waited, an older read never
    // replaces a newer one, and another project's form never shows while this one's is read. main answers from the forms
    // as they are now (the models), each held read with the model of when it was asked.
    const models = { [project]: await inv('workflow:form', project), [notes]: await inv('workflow:form', notes) }
    await app.evaluate(({ ipcMain }, m) => {
      globalThis.__wf = { hold: {}, held: [], models: m }
      ipcMain.removeHandler('workflow:form')
      ipcMain.handle('workflow:form', (_e, p) => {
        const s = globalThis.__wf
        if (s.hold[p]) return new Promise((r) => s.held.push({ p, r, m: s.models[p] }))
        return s.models[p]
      })
    }, models)
    const hold = (p, on) => app.evaluate((_, [x, v]) => void (globalThis.__wf.hold[x] = v), [p, on])
    const release = (p) =>
      app.evaluate((_, x) => {
        const s = globalThis.__wf
        for (const h of s.held.filter((y) => y.p === x)) h.r(h.m)
        s.held = s.held.filter((y) => y.p !== x)
      }, p)
    const reject = (p) =>
      app.evaluate((_, x) => {
        const s = globalThis.__wf
        for (const h of s.held.filter((y) => y.p === x)) h.r(Promise.reject(new Error('the read failed (held by the test)')))
        s.held = s.held.filter((y) => y.p !== x)
      }, p)
    const heldFor = (p) => app.evaluate((_, x) => globalThis.__wf.held.filter((y) => y.p === x).length, p)
    const changedElsewhere = (p) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'workflow-changed', workspacePath: ws, projectPath: p })
    // After a release, a read of the window's own answered after it: the held answer has been taken (or dropped) by then.
    const fence = (p) => inv('workflow:form', p)
    // An edit made while a reload waits stays.
    await hold(notes, true)
    await changedElsewhere(notes)
    check('a reload of notes is held', !!(await lib.until(async () => (await heldFor(notes)) > 0, HUNG_MS)))
    await row('review').locator('select').selectOption('you')
    await release(notes)
    await hold(notes, false)
    await fence(notes)
    check('an edit made while a reload waited stays (You, not the read’s No one)', !!(await lib.until(async () => (await row('review').locator('select').inputValue()) === 'you', HUNG_MS)) && (await section.getByRole('button', { name: 'Discard Changes' }).isEnabled()))
    await discard()
    // A reload that fails while the draft has an edit keeps the form and the edit (HR5's round 2).
    await hold(notes, true)
    await changedElsewhere(notes)
    check('another reload of notes is held', !!(await lib.until(async () => (await heldFor(notes)) > 0, HUNG_MS)))
    await row('excluded').locator('input').fill('build')
    await row('excluded').locator('input').blur()
    await reject(notes)
    await hold(notes, false)
    await fence(notes)
    check('a reload that fails keeps the form and its edits, Save and Discard there', !!(await lib.until(async () => (await row('excluded').locator('input').inputValue()) === 'build' && (await section.getByRole('button', { name: 'Discard Changes' }).isEnabled()), HUNG_MS)) && (await page.locator('.s-desc.error', { hasText: 'read the workflow options' }).count()) === 0)
    await discard()
    // An older read answering after a newer one is dropped.
    await hold(notes, true)
    await changedElsewhere(notes)
    await lib.until(async () => (await heldFor(notes)) > 0, HUNG_MS)
    await hold(notes, false)
    await app.evaluate((_, x) => {
      const m = globalThis.__wf.models[x]
      globalThis.__wf.models[x] = { ...m, own: { ...m.own, excluded: ['dist'] } }
    }, notes)
    await changedElsewhere(notes)
    check('the newer read shows', !!(await lib.until(async () => (await row('excluded').locator('input').inputValue()) === 'dist', HUNG_MS)))
    await release(notes)
    await fence(notes)
    check('…and the older one, answering after it, is dropped', !!(await lib.until(async () => (await row('excluded').locator('input').inputValue()) === 'dist', HUNG_MS)))
    // Another project's form never shows: web's reload held, notes selected while its own read is held, web's answer then.
    await page.getByText('web', { exact: true }).first().click()
    check('web’s form shown', !!(await lib.until(async () => (await section.getAttribute('data-platform').catch(() => null)) === 'git', HUNG_MS)))
    await hold(project, true)
    await changedElsewhere(project)
    await lib.until(async () => (await heldFor(project)) > 0, HUNG_MS)
    await hold(notes, true)
    await page.getByText('notes', { exact: true }).first().click()
    check('notes is selected while its read is held', !!(await lib.until(async () => (await page.locator('.project-header', { hasText: 'notes' }).count()) > 0 && (await heldFor(notes)) > 0, HUNG_MS)))
    check('…and web’s form isn’t shown for it meanwhile', (await page.locator('.workflow-form[data-platform="git"]').count()) === 0)
    await release(project)
    await hold(project, false)
    await fence(project)
    check('web’s late answer doesn’t show under notes', !!(await lib.until(async () => (await page.locator('.workflow-form[data-platform="git"]').count()) === 0, HUNG_MS)))
    await release(notes)
    await hold(notes, false)
    check('notes’ own form shows once its read answers', !!(await lib.until(async () => (await section.getAttribute('data-platform').catch(() => null)) === 'none', HUNG_MS)))

    // --- German, among the longest labels, and Polish: the groups and the presets.
    await page.getByText('web', { exact: true }).first().click()
    await reopen()
    const base = (await inv('app:info')).language
    let messages = null
    const speak = async (code) => {
      const dir = path.join(lib.ROOT, 'locales', code)
      messages = code === 'en' ? null : Object.assign({}, ...fs.readdirSync(dir).filter((x) => x.endsWith('.json')).map((x) => JSON.parse(fs.readFileSync(path.join(dir, x), 'utf8'))))
      await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: messages ? { ...base, code, locale: code, messages } : base })
    }
    /**
     * The save's dialog opened in the window's language (#1489): its title, message, what changes (Merge style, its
     * values) and Save in `code`'s words, read from its catalogue; shot in both themes, then cancelled.
     */
    const saveDialogIn = async (code) => {
      const m = (id) => messages[id]
      const style = row('style').locator('select')
      const from = await style.inputValue()
      const to = from === 'squash' ? 'merge' : 'squash'
      await style.selectOption(to)
      await save.click()
      const d = page.locator('.dialog', { hasText: m('workflow.form.confirmTitle') })
      const shown = !!(await lib.until(async () => (await d.count()) === 1, HUNG_MS))
      const line = `${m('workflow.option.style.title')}: ${m(`workflow.value.style.${from}`)} → ${m(`workflow.value.style.${to}`)}`
      const text = shown ? await d.innerText() : ''
      const parts = [m('workflow.form.confirmMessage'), m('workflow.form.changesHead'), line]
      check(`${code}: the save's dialog in its language: title, message, what changes`, shown && parts.every((p) => text.includes(p)), JSON.stringify({ text, missing: parts.filter((p) => !text.includes(p)) }))
      check(`${code}: …and its Save button`, shown && (await d.getByRole('button', { name: m('workflow.form.save').replace(/…$/, ''), exact: true }).count()) === 1, text)
      await themes(`save-${code}`)
      await d.getByRole('button', { name: m('shell.dialog.cancel'), exact: true }).click()
      await lib.until(async () => (await d.count()) === 0, HUNG_MS)
      await style.selectOption(from)
    }
    await speak('de')
    check('the section shows in German', !!(await lib.until(async () => (await section.innerText()).includes('Wer mergt'), HUNG_MS)))
    await choice('team').click()
    await preview.waitFor({ timeout: HUNG_MS })
    await themes('presets-de', section.locator('.workflow-group[data-group="presets"]'))
    await preview.getByRole('button').last().click()
    await themes('groups-de', section.locator('.workflow-group[data-group="merging"]'))
    await saveDialogIn('de')
    await speak('pl')
    check('the section shows in Polish', !!(await lib.until(async () => (await section.innerText()).includes('Kto scala'), HUNG_MS)))
    await themes('groups-pl', section.locator('.workflow-group[data-group="review"]'))
    await saveDialogIn('pl')
    await speak('en')
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await app
      .firstWindow()
      .then((p) => p.screenshot({ path: path.join(lib.WORK, 'workflowoptions-failed.png') }))
      .catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }

  // --- G4 set from the tab decides a clean rebase (S9): with Same change an approved card rebased cleanly onto a newer
  // target keeps its pass (CarriedOver); with Exact revision only, the same rebase makes it stale. The agent merges, so
  // nothing merges meanwhile.
  const fx = q.queueProject('workflowoptions-g4')
  q.prepare(fx)
  let h = null
  try {
    h = await q.startHive(fx, { port: lib.port(47857), keepOptions: true })
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges', mergeChecks: [] }) })
    await h.page.getByText('alpha', { exact: true }).first().click()
    await h.page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await h.page.locator('.git-sections [data-section="workflow"]').click()
    const g = await theForm(h.page, h.app, h.inv)
    const sameness = async (value) => {
      await g.row('sameness').locator('select').selectOption(value)
      await g.saveAll()
      return lib.until(() => JSON.parse(fs.readFileSync(path.join(fx.alpha, '.combwork', 'project.json'), 'utf8')).workflow?.options?.sameness === value, HUNG_MS)
    }
    const reviewer = await q.agent(fx, h, 'R1')
    check('G4: Same change saved from the tab', !!(await sameness('change')))
    const kept = await q.approve(fx, h, reviewer, 'Same change card', { 'b.txt': 'same\n' })
    check('G4: Exact revision only saved from the tab', !!(await sameness('exact')))
    const exact = await q.approve(fx, h, reviewer, 'Exact revision card', { 'c.txt': 'exact\n' })
    check('both cards approved', !!(await lib.until(async () => (await h.card(kept.n))?.column === 'passed' && (await h.card(exact.n))?.column === 'passed', HUNG_MS)), JSON.stringify([kept.steps, exact.steps]))
    // The target moves on, and each builder rebases its card cleanly onto it.
    q.commitOn(fx, 'integration', { 'd.txt': 'elsewhere\n' }, 'Someone else’s change')
    for (const c of [kept, exact]) lib.git(c.builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'rebase', '-q', 'integration'])
    check('Same change: the pass carries over (CarriedOver), the card stays approved', !!(await lib.until(async () => (await h.kinds(kept.n)).includes('CarriedOver'), 30000)) && !(await h.kinds(kept.n)).includes('Stale'), JSON.stringify(await h.kinds(kept.n)))
    check('Exact revision only: the same rebase makes the pass stale', !!(await lib.until(async () => (await h.kinds(exact.n)).includes('Stale'), 30000)) && !(await h.kinds(exact.n)).includes('CarriedOver'), JSON.stringify(await h.kinds(exact.n)))
  } catch (e) {
    check('G4’s part ran to the end', false, e.stack ?? String(e))
  } finally {
    if (h) await h.app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nworkflowoptions: all checks passed')
  process.exit(failed ? 1 : 0)
})()
