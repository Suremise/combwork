// Templates v2 and Hive's own (#1436, SPEC §16.10.6), on fake Claude Code with the Assistant off and Codex turned off:
// a workspace opened with 0.9's templates (the workspace's and a project's) sets them aside into the 0.9 backup's folder
// and says so once in the Notifications panel; importing a 0.9 file is refused, saying why; the Templates view lists
// Hive's six, read-only, with the preset each suggests; Team 3×3 loaded into a project from the view makes six agents
// named from its key, builders and reviewers paired both ways, in a grid of six, none in a worktree, Codex's agents on
// Claude Code with a note on their rows; Pair loaded from + Add ▾ → Templates with "Also switch this project to Pair…"
// ticked lands in Version Control → Workflow with Pair chosen and not saved. Screenshots of the Hive templates, and of
// the load dialog's suggestion and swap note, in both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; a quiet test copy. (0.9's templates set aside at the board's real upgrade, the upgrade waiting, and
// Restore putting them back: tests/upgradeTemplates.test.ts, on boards made 0.9's.)
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'templatesv2-profile')
const ws = path.join(lib.WORK, 'templatesv2-ws')
const claudeHome = path.join(lib.WORK, 'templatesv2-claude-home')
const shots = path.join(lib.WORK, 'templatesv2-shots')
const files = path.join(lib.WORK, 'templatesv2-files')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
/** A template file as Hive 0.9 wrote it: version 1, an agent with a worktree of its own. */
const v09 = (name) => JSON.stringify({ version: 1, name, savedAt: '2026-10-01T10:00:00.000Z', layout: 'columns2', agents: [{ name: 'Tree', provider: 'claude-code', worktree: true }, { name: 'Folder', role: 'reviewer', provider: 'claude-code', worktree: false }] }, null, 2)

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome, shots, files]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots, files]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  fs.mkdirSync(path.join(alpha, '.hive', 'templates'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-old', name: 'Old', provider: 'claude-code' }] }))
  // 0.9's templates, as an upgraded workspace has them: the workspace's (with its kept copy) and alpha's own.
  fs.mkdirSync(path.join(ws, '.hive', 'templates'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.hive', 'templates', 'old-pair.json'), v09('Old pair'))
  fs.writeFileSync(path.join(ws, '.hive', 'templates', 'old-pair.json.bak'), v09('Old pair'))
  fs.writeFileSync(path.join(alpha, '.hive', 'templates', 'mine.json'), v09('Mine'))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  // Claude Code only: Codex stays turned off, so Hive's templates' reviewers run on Claude Code (#1436's swap).
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47800), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const projectCfg = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8'))
    const shoot = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await target().screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- 0.9's templates set aside as the workspace opens in 1.0, into the 0.9 backup's folder, said once.
    const backup = path.join(ws, '.hive', 'backups', 'templates-0.9')
    const listed = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
    const projectsDir = path.join(backup, 'projects')
    check("0.9's templates are moved into the backup's folder (the workspace's with its kept copy, and alpha's by its id)", !!(await until(async () => JSON.stringify(listed(path.join(backup, 'workspace'))) === '["old-pair.json","old-pair.json.bak"]' && listed(projectsDir).length === 1 && JSON.stringify(listed(path.join(projectsDir, listed(projectsDir)[0]))) === '["mine.json"]', HUNG_MS)), JSON.stringify([listed(path.join(backup, 'workspace')), listed(projectsDir)]))
    check('…gone from where they were', listed(path.join(ws, '.hive', 'templates')).length === 0 && listed(path.join(alpha, '.hive', 'templates')).length === 0)
    await page.locator('.activitybar .activity-btn[aria-label="Notifications"]').click()
    const notice = page.locator('.notif-panel .notif-item', { hasText: 'Your 0.9 agent templates were set aside' })
    check('one quiet notice says so, in the Notifications panel', !!(await until(async () => (await notice.count()) === 1, HUNG_MS)) && /1\.0 templates don't pin agents to worktrees\. The Hive templates replace them; the 2 files are kept with the 0\.9 board backup\./.test(await notice.innerText()), await page.locator('.notif-panel').innerText().catch(() => ''))
    await shoot('notice', () => page.locator('.notif-panel'))
    await page.locator('.notif-panel [aria-label="Close"]').click()

    // --- The Templates view: Hive's six first, read-only, each suggesting a preset.
    await page.locator('.activitybar [aria-label="Templates"]').click()
    const sidebar = page.locator('.sidebar')
    const hiveRows = sidebar.locator('.template-row[data-scope="hive"]')
    check("the Templates view lists Hive's own: Solo, Pair, Pair: one provider, Team 3×3, Team 6×6, Team 6 + pool", !!(await until(async () => JSON.stringify(await hiveRows.evaluateAll((l) => l.map((x) => x.getAttribute('aria-label')))) === JSON.stringify(['Solo', 'Pair', 'Pair: one provider', 'Team 3×3', 'Team 6×6', 'Team 6 + pool']), HUNG_MS)), JSON.stringify(await hiveRows.evaluateAll((l) => l.map((x) => x.getAttribute('aria-label')))))
    check('…and none of the 0.9 ones', (await sidebar.locator('.template-row:not([data-scope="hive"])').count()) === 0)
    await sidebar.locator('.template-row[data-scope="hive"][aria-label="Team 3×3"]').click()
    const detail = page.locator('.main-area > .tab-body .template-detail[data-scope="hive"]')
    await until(async () => (await detail.count()) === 1, HUNG_MS)
    const actions = await detail.locator('.template-detail-actions button').allInnerTexts()
    check("one of Hive's own is read-only: Load, Duplicate and Export, no Edit, Rename or Delete", actions.map((t) => t.trim()).join() === 'Load into Project…,Duplicate…,Export…' && (await detail.locator('[aria-label="Delete template"]').count()) === 0, JSON.stringify(actions))
    const team = (await detail.locator('table tbody tr').allInnerTexts()).map((r) => r.split('\t').map((c) => c.trim()))
    // (Named as the selected project, alpha, would get them: its key's, #1123 names.)
  check("…its agents: builders on Claude Code, each paired with a reviewer on Codex, named from the selected project's key", team.length === 6 && /^[A-Z]{2,4}-B1$/.test(team[0][0]) && /^Builder\s+with [A-Z]{2,4}-R1$/.test(team[0][1]) && team[0][2] === 'Claude Code' && /^Reviewer\s+with [A-Z]{2,4}-B3$/.test(team[5][1]) && team[5][2] === 'Codex', JSON.stringify(team))
    check('…and the preset it suggests', /Suggests the Team preset/.test(await detail.innerText()))
    await shoot('hive-templates', () => page)

    // --- Export… and Duplicate… of Hive's own, clicked (HR3's round 1, 2), while the workspace has another template in
    // a file of the same name: the Hive one is the one exported and copied; the workspace's is left as it is.
    const sameFile = path.join(ws, '.hive', 'templates', 'team-3x3.json')
    const mine = JSON.stringify({ version: 2, name: 'Mine', savedAt: '2026-10-22T10:00:00.000Z', layout: 'auto', agents: [{ name: 'Solo one', role: 'builder', provider: 'claude-code' }] }, null, 2)
    fs.writeFileSync(sameFile, mine)
    await sidebar.locator('[aria-label="Refresh"]').click()
    await until(async () => (await sidebar.locator('.template-row[data-scope="workspace"][aria-label="Mine"]').count()) === 1, HUNG_MS)
    await sidebar.locator('.template-row[data-scope="hive"][aria-label="Team 3×3"]').click()
    const exported = path.join(files, 'Team 3x3.hive-template.json')
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
    }, exported)
    await detail.getByRole('button', { name: 'Export…' }).click()
    const out = await until(async () => (fs.existsSync(exported) ? JSON.parse(fs.readFileSync(exported, 'utf8')) : null), HUNG_MS)
    check("Export… writes Hive's Team 3×3, not the workspace's file of that name", out?.name === 'Team 3×3' && out.agents.length === 6 && out.suggestedPreset === 'team' && out.pairs?.length === 3, JSON.stringify(out).slice(0, 200))
    await detail.getByRole('button', { name: 'Duplicate…' }).click()
    const dup = page.locator('.dialog', { hasText: 'Duplicate "Team 3×3"' })
    await until(async () => (await dup.count()) === 1, HUNG_MS)
    await dup.locator('select').selectOption({ label: 'The workspace (every project)' })
    await dup.getByRole('button', { name: 'Duplicate', exact: true }).click()
    const copy = sidebar.locator('.template-row[data-scope="workspace"][aria-label="Team 3×3"]')
    check("Duplicate… copies Hive's Team 3×3 into the workspace, as its own file", !!(await until(async () => (await copy.count()) === 1, HUNG_MS)) && fs.readdirSync(path.join(ws, '.hive', 'templates')).some((f) => f !== 'team-3x3.json' && f.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(ws, '.hive', 'templates', f), 'utf8')).name === 'Team 3×3'), JSON.stringify(fs.readdirSync(path.join(ws, '.hive', 'templates'))))
    check("…the workspace's own file of that name untouched", fs.readFileSync(sameFile, 'utf8') === mine)
    await sidebar.locator('.template-row[data-scope="hive"][aria-label="Team 3×3"]').click()
    await until(async () => (await detail.count()) === 1, HUNG_MS)

    // --- A 0.9 file imported: refused, saying why; nothing written.
    const old = path.join(files, 'old.hive-template.json')
    fs.writeFileSync(old, v09('From 0.9'))
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    }, old)
    const wsBefore = JSON.stringify(listed(path.join(ws, '.hive', 'templates')))
    await sidebar.locator('[aria-label="Import Template…"]').click()
    check('importing a 0.9 template is refused, saying why', !!(await until(async () => (await page.locator('.toast').allInnerTexts()).some((t) => /Could not import the template[\s\S]*This template is from Hive 0\.9 and can't be loaded in 1\.0\. Recreate it from your agents with Save as Template\./.test(t)), HUNG_MS)) && JSON.stringify(listed(path.join(ws, '.hive', 'templates'))) === wsBefore, (await page.locator('.toast').allInnerTexts()).join(' | '))

    // --- Team 3×3 into alpha from the view: six agents named from its key, paired, in a grid, none in a worktree.
    const branches = lib.git(alpha, ['branch', '--list'])
    await detail.getByRole('button', { name: 'Load into Project…' }).click()
    const dialog = page.locator('.dialog').last()
    await dialog.locator('select').selectOption({ label: 'alpha' })
    await dialog.getByRole('button', { name: 'Continue' }).click()
    const teamLoad = page.locator('.dialog', { hasText: 'Load "Team 3×3"?' })
    check('the load dialog shows', !!(await until(async () => (await teamLoad.locator('.template-plan-name-input').count()) === 6, HUNG_MS)))
    const names = await teamLoad.locator('.template-plan-name-input').evaluateAll((l) => l.map((x) => x.value))
    const key = names[0].split('-')[0]
    const want = ['B1', 'B2', 'B3', 'R1', 'R2', 'R3'].map((n) => `${key}-${n}`)
    check("…its agents named from alpha's key (#1123 names)", /^[A-Z]{2,4}$/.test(key) && JSON.stringify(names) === JSON.stringify(want), JSON.stringify(names))
    check('…its reviewers on Claude Code, Codex being off, said on their rows', (await teamLoad.locator('.template-plan-swapped').allInnerTexts()).map((t) => t.trim()).join('|') === Array(3).fill('Codex is turned off (Settings → Providers): Claude Code instead.').join('|'), JSON.stringify(await teamLoad.locator('.template-plan-swapped').allInnerTexts()))
    check('…and offers its preset, unticked', (await teamLoad.locator('.dialog-check').innerText().catch(() => '')).trim().startsWith('Also switch this project to Team…') && !(await teamLoad.locator('.dialog-check input').isChecked()))
    await teamLoad.getByRole('button', { name: 'Load template' }).click()
    const loaded = await until(async () => {
      const c = projectCfg()
      return c.agents.length === 6 && c.agents[0].name === want[0] ? c : null
    }, HUNG_MS)
    check('Team 3×3 makes six agents with their roles, paired both ways, all on Claude Code', !!loaded && JSON.stringify(loaded.agents.map((a) => [a.name, a.workflowRole, a.pairedWith, a.provider])) === JSON.stringify(want.map((n, i) => [n, i < 3 ? 'builder' : 'reviewer', want[i < 3 ? i + 3 : i - 3], 'claude-code'])), JSON.stringify(loaded?.agents))
    check('…in a grid of six, none in a worktree, no branch made', loaded?.layout === 'grid6' && loaded.agents.every((a) => !a.worktree) && lib.git(alpha, ['branch', '--list']) === branches, JSON.stringify(loaded?.layout))
    check("…and the project's options untouched (nothing ticked)", !projectCfg().workflow?.preset)
    await page.locator('.activitybar [aria-label="Projects"]').click()
    await page.getByText('alpha', { exact: true }).first().click()
    check('…all six shown at once', !!(await until(async () => (await lib.agentCount(page)) === 6, HUNG_MS)))

    // --- Pair from + Add ▾ → Templates: its suggestion and its swap note; ticked, Version Control → Workflow with Pair
    // chosen, not saved.
    await lib.addMenuRun(page, 'Templates')
    const item = (label) => page.locator('.menu .menu-item').filter({ has: page.getByText(label, { exact: true }) }).first()
    await until(async () => (await item('Pair').count()) === 1, HUNG_MS)
    await item('Pair').click()
    const pairLoad = page.locator('.dialog', { hasText: 'Load "Pair"?' })
    check('Pair: the load dialog shows', !!(await until(async () => (await pairLoad.locator('.template-plan-swapped').count()) === 1, HUNG_MS)))
    const tick = pairLoad.locator('.dialog-check')
    check('…offering to switch the project to Pair', /^Also switch this project to Pair… \(opens Version Control → Workflow with it chosen, to save there\)$/.test((await tick.innerText()).trim()), await tick.innerText())
    await shoot('load-suggestion', () => pairLoad)
    await tick.locator('input').check()
    await pairLoad.getByRole('button', { name: 'Load template' }).click()
    check('Pair loaded', !!(await until(async () => JSON.stringify(projectCfg().agents.map((a) => a.name)) === JSON.stringify([`${key}-B1`, `${key}-R1`]), HUNG_MS)), JSON.stringify(projectCfg().agents.map((a) => a.name)))
    const presetNow = page.locator('.workflow-preset-now')
    check('…then Version Control → Workflow, Pair chosen', !!(await until(async () => (await presetNow.getAttribute('data-preset-now').catch(() => null)) === 'pair', HUNG_MS)), String(await presetNow.getAttribute('data-preset-now').catch(() => null)))
    check('…not saved: Save waits for the user, the options as they were', (await page.locator('button[data-action="save"]').isEnabled()) && !projectCfg().workflow?.preset, JSON.stringify(projectCfg().workflow))
    await shoot('switch-preset', () => page)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
