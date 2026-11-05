// The Git view (#607): the project's Git tab (Changes, History, Branches & remotes) and its status bar item. The item
// shows "main · origin · ↑0 ↓0" and opens Branches & remotes; ahead/behind moves only when the user fetches (another
// clone's push shows nothing until Fetch); Pull fast-forwards; New branch… switches to it and Push sets its upstream;
// a branch's Switch is disabled, with why, while an agent works in the project folder; History lists the commits and
// Create tag… tags the commit; Add remote… adds one, and a GitHub remote with a personal email warns; a project without
// git (None, #1416) says so under the header, Initialise repository… shown once Git is chosen (HI-1905). Remotes are local bare repositories in the suite's folder (never a real remote), git's
// global config is the suite's own (GIT_CONFIG_GLOBAL), and the agent is the fake Claude Code. Dev build, throwaway
// profile and workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'gitview-profile')
const ws = path.join(lib.WORK, 'gitview-ws')
const remote = path.join(lib.WORK, 'gitview-remote.git')
const other = path.join(lib.WORK, 'gitview-other')
const claudeHome = path.join(lib.WORK, 'gitview-claude-home')
const globalConfig = path.join(lib.WORK, 'gitview-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `gitview-${name}.png`) })

;(async () => {
  for (const d of [userData, ws, remote, other, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  // The suite's own global git config: a personal address, as most users have (the GitHub warning's case).
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = test.user@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
  fs.mkdirSync(alpha, { recursive: true })
  fs.mkdirSync(path.join(ws, 'beta'), { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: gitEnv })
  g(ws, 'init', '-q', '-b', 'main', alpha)
  fs.writeFileSync(path.join(alpha, 'a.txt'), 'a\n')
  g(alpha, 'add', '-A')
  g(alpha, 'commit', '-qm', 'first commit')
  g(alpha, 'remote', 'add', 'origin', remote)
  g(alpha, 'push', '-q', '-u', 'origin', 'main')
  g(lib.WORK, 'clone', '-q', remote, other)
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])

  const { app, page } = await lib.launch({ userData, env: { ...claude, CW_API_PORT: lib.port(47880), GIT_CONFIG_GLOBAL: globalConfig }, viewport: { width: 1500, height: 900 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const text = (loc) => loc.innerText().catch(() => '')

  // --- The status bar item, and the Git tab it opens.
  await page.getByText('alpha', { exact: true }).first().click()
  const item = page.locator('.statusbar [data-git-status]')
  check('the status bar shows branch · remote · ahead/behind', !!(await lib.until(async () => (await text(item)).includes('main · origin · ↑0 ↓0'), HUNG_MS)), await text(item))
  await item.click()
  const branches = page.locator('[data-git-branches]')
  check('it opens Git → Branches & remotes', !!(await lib.until(async () => (await branches.count()) === 1, HUNG_MS)) && (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1)
  check('the current branch and its upstream', !!(await lib.until(async () => (await text(branches.locator('[data-git-head]'))) === 'main' && (await text(branches.locator('[data-git-upstream]'))).includes('origin/main · ↑0 ↓0'), HUNG_MS)))
  check("it says it's never fetched (Combwork never fetches by itself)", /Never fetched\. Combwork never fetches by itself/.test(await text(branches.locator('[data-git-fetched]'))), await text(branches.locator('[data-git-fetched]')))
  await shot(page, '1-branches')

  // --- Another clone pushes: nothing moves until Fetch; Pull then brings it in.
  fs.writeFileSync(path.join(other, 'b.txt'), 'b\n')
  g(other, 'add', '-A')
  g(other, 'commit', '-qm', 'their commit')
  g(other, 'push', '-q', 'origin', 'main')
  // Read now, after their push: the counts are as of the last fetch, so nothing has moved.
  const now = await inv('git:summary', alpha)
  check('no automatic fetch: still ↑0 ↓0', now.upstream?.behind === 0 && now.fetchedAt === null, JSON.stringify(now.upstream))
  await branches.getByRole('button', { name: 'Fetch', exact: true }).click()
  check('Fetch: ↓1, with when it fetched', !!(await lib.until(async () => (await text(branches.locator('[data-git-ab]'))) === '↑0 ↓1' && /As of the last fetch, just now/.test(await text(branches.locator('[data-git-fetched]'))), HUNG_MS)), await text(branches.locator('[data-git-current]')))
  check('the status bar follows', !!(await lib.until(async () => (await text(item)).includes('main · origin · ↑0 ↓1'), HUNG_MS)), await text(item))
  await branches.getByRole('button', { name: 'Pull', exact: true }).click()
  check('Pull fast-forwards: the file is there and ↓0', !!(await lib.until(async () => fs.existsSync(path.join(alpha, 'b.txt')) && (await text(branches.locator('[data-git-ab]'))) === '↑0 ↓0', HUNG_MS)))

  // --- New branch… (switching to it), and Push setting its upstream.
  await branches.getByRole('button', { name: 'New branch…', exact: true }).click()
  const dialog = page.locator('.dialog', { hasText: 'New branch' })
  await dialog.locator('input.input').fill('feature/demo')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  check('New branch… creates it and switches to it', !!(await lib.until(async () => (await text(branches.locator('[data-git-head]'))) === 'feature/demo', HUNG_MS)) && g(alpha, 'symbolic-ref', '--short', 'HEAD') === 'feature/demo')
  check('the status bar says it has no upstream', !!(await lib.until(async () => (await text(item)).includes('feature/demo · no upstream'), HUNG_MS)), await text(item))
  await branches.getByRole('button', { name: 'Push', exact: true }).click()
  const pushDialog = page.locator('.dialog', { hasText: 'Push feature/demo' })
  await pushDialog.getByRole('button', { name: 'Push', exact: true }).click()
  check('Push sets its upstream on the remote', !!(await lib.until(async () => (await text(branches.locator('[data-git-upstream]'))).includes('origin/feature/demo'), HUNG_MS)) && g(remote, 'branch', '--list', 'feature/demo').includes('feature/demo'))

  // --- Switch back, from the branch's row.
  const mainRow = branches.locator('[data-branch="main"]')
  await mainRow.getByRole('button', { name: 'Switch', exact: true }).click()
  await page.locator('.dialog', { hasText: 'Switch alpha to main?' }).getByRole('button', { name: 'Switch', exact: true }).click()
  check("a branch's Switch switches the project folder", !!(await lib.until(async () => (await text(branches.locator('[data-git-head]'))) === 'main', HUNG_MS)) && g(alpha, 'symbolic-ref', '--short', 'HEAD') === 'main')

  // --- An agent working in the project folder: Switch and Pull are disabled, saying why.
  const a1 = await lib.addAgent(inv, alpha, { name: 'Worker' })
  await inv('session:start', alpha, { agentId: a1.id })
  await lib.acceptClaudeTrust(inv, alpha, a1.id)
  const launch = await lib.until(async () => (await inv('session:live')).find((l) => l.agentId === a1.id && l.runId) ?? null, HUNG_MS)
  const hook = launch && (await lib.until(async () => lib.launchHook(userData, launch.runId), HUNG_MS))
  const post = (body) => fetch(hook.url, { method: 'POST', headers: { Authorization: `Bearer ${hook.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  await post({ session_id: launch.sessionId, hook_event_name: 'UserPromptSubmit', cwd: alpha, prompt: 'work' })
  const featureSwitch = branches.locator('[data-branch="feature/demo"]').getByRole('button', { name: 'Switch', exact: true })
  check('Switch is disabled while the agent works in the folder', !!(await lib.until(async () => await featureSwitch.isDisabled(), HUNG_MS)))
  const why = await lib.hoverTip(page, featureSwitch.locator('xpath=..'), (t) => t.includes('Worker'))
  check('and says why', why.includes('Worker is working in the project folder: switch branches once it has finished.'), why)
  await shot(page, '2-busy')
  check('main refuses it too', /Worker is working in the project folder/.test(await inv('git:switch', alpha, 'feature/demo').then(() => 'switched', (e) => e.message)))
  await post({ session_id: launch.sessionId, hook_event_name: 'Stop' })
  check('Switch comes back when the agent has finished', !!(await lib.until(async () => !(await featureSwitch.isDisabled()), HUNG_MS)))
  await inv('session:stop', alpha, a1.id)

  // --- Remotes and the identity warning: a GitHub remote with a personal email.
  await branches.getByRole('button', { name: 'Add remote…', exact: true }).click()
  const add = page.locator('.dialog', { hasText: 'Add a remote' })
  await add.locator('#git-form-name').fill('gh')
  await add.locator('#git-form-url').fill('https://github.com/example/alpha.git')
  await add.getByRole('button', { name: 'Add', exact: true }).click()
  const added = !!(await lib.until(async () => (await branches.locator('[data-remote="gh"]').count()) === 1, HUNG_MS)) && g(alpha, 'remote').includes('gh')
  // HI-1854: under load it was added but never shown (a git read of the view's never answered): what was on screen, git's
  // remotes, and whether the view's read was still under way (its reload button turning).
  let notAdded = ''
  if (!added) {
    await shot(page, 'add-remote-failed')
    const reading = (await branches.locator('[data-action="reload-branches"] .spin').count()) > 0
    notAdded = `dialogs: ${JSON.stringify(await page.locator('.dialog').allInnerTexts())}; git remote: ${JSON.stringify(g(alpha, 'remote'))}; the view still reading: ${reading}`
  }
  check('Add remote… adds it', added, notAdded)
  const warning = branches.locator('[data-identity-warning]')
  check('a personal email on a GitHub remote warns', !!(await lib.until(async () => /show test\.user@example\.com to anyone/.test(await text(warning)), HUNG_MS)), await text(warning))
  check('the identity used is the global one', (await text(branches.locator('[data-identity-used="email"]'))) === 'test.user@example.com')
  await branches.getByRole('button', { name: 'Set for this repository…', exact: true }).click()
  const idDialog = page.locator('.dialog', { hasText: 'Commit identity for this repository' })
  await idDialog.locator('#git-form-email').fill('1+test@users.noreply.github.com')
  await idDialog.getByRole('button', { name: 'Save', exact: true }).click()
  check("this repository's no-reply address clears the warning", !!(await lib.until(async () => (await warning.count()) === 0 && (await text(branches.locator('[data-identity-used="email"]'))) === '1+test@users.noreply.github.com', HUNG_MS)) && g(alpha, 'config', '--local', 'user.email') === '1+test@users.noreply.github.com')
  await shot(page, '3-remotes')

  // --- History and tags.
  await page.locator('.git-sections button', { hasText: 'History' }).click()
  const history = page.locator('[data-git-history]')
  check('History lists the commits, newest first', !!(await lib.until(async () => (await history.locator('.git-commit').count()) === 2, HUNG_MS)) && (await text(history.locator('.git-commit').first())).includes('their commit'))
  await history.getByRole('button', { name: 'Create tag…', exact: true }).click()
  const tag = page.locator('.dialog', { hasText: 'Tag ' })
  await tag.locator('#git-form-name').fill('v0.1')
  await tag.locator('#git-form-message').fill('First release')
  await tag.locator('#git-form-push').selectOption('origin')
  await tag.getByRole('button', { name: 'Create tag', exact: true }).click()
  check('Create tag… tags the commit and pushes it', !!(await lib.until(async () => (await history.locator('[data-tag="v0.1"]').count()) === 1, HUNG_MS)) && g(remote, 'tag', '--list').includes('v0.1'))
  await shot(page, '4-history')

  // --- #1643: the project's work goes to release (its target), 25 commits past main, made as a terminal would.
  let tip = g(alpha, 'rev-parse', 'main')
  for (let i = 1; i <= 25; i++) tip = g(alpha, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', `release work ${i}`)
  g(alpha, 'branch', 'release', tip)
  await inv('workflow:setOptions', alpha, { preset: null, options: { target: 'release' } })
  await history.locator('[data-action="reload-history"]').click()
  const onPage = async (ref, page_, n) => (await history.getAttribute('data-history-ref')) === ref && (await history.getAttribute('data-history-page')) === String(page_) && (await history.locator('.git-commit').count()) === n
  check('History opens on the target, release, 20 commits a page', !!(await lib.until(() => onPage('refs/heads/release', 1, 20), HUNG_MS)) && (await text(history.locator('.git-commit').first())).includes('release work 25') && /Page 1 of 2/.test(await text(history.locator('.table-paging'))), await text(history.locator('h2').first()))
  check('…its picker names it the target, and lists main and origin’s', (await history.locator('[data-history-branch] option:checked').innerText()) === 'release · target' && (await history.locator('[data-history-branch] option[value="refs/heads/main"]').innerText()) === 'main · project folder' && (await history.locator('[data-history-branch] option[value="refs/remotes/origin/main"]').count()) === 1)
  for (const t of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
    await page.mouse.move(5, 5)
    // The earlier notices closed, and the pager in view: the page as it shows.
    for (const close of await page.locator('.toast .toast-close, .toast button[aria-label="Close"]').all()) await close.click().catch(() => undefined)
    await lib.until(async () => (await page.locator('.toast').count()) === 0, HUNG_MS)
    await history.locator('[data-history-branch]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, `gitview-5-history-target-${t}.png`) })
    await history.locator('.table-paging').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, `gitview-6-history-pager-${t}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await history.getByRole('button', { name: 'Next page', exact: true }).click()
  check('Next page: the older commits, back to the first', !!(await lib.until(() => onPage('refs/heads/release', 2, 7), HUNG_MS)) && (await text(history.locator('.git-commit').last())).includes('first commit'), await text(history))
  await history.locator('[data-history-branch]').selectOption('refs/heads/main')
  check('the picker shows main: its own commits, from its first page', !!(await lib.until(() => onPage('refs/heads/main', 1, 2), HUNG_MS)) && (await history.locator('.table-paging').count()) === 0)

  // --- Changes: with a target set (release, above), it opens on the target compared with main (HI-1824); the project
  // folder in its picker shows the working tree.
  await page.locator('.git-sections button', { hasText: 'Changes' }).click()
  const comparing = page.locator('[data-compare-page]')
  check('Changes opens on the target compared with main', !!(await lib.until(async () => (await comparing.count()) === 1 && (await comparing.getAttribute('data-compare-base')) === 'main' && (await comparing.getAttribute('data-compare-head')) === 'release', HUNG_MS)))
  await page.locator('select.changes-picker').selectOption('')
  check('its project folder shows the working tree', !!(await lib.until(async () => (await page.locator('.split-list .pane-header', { hasText: 'Changes' }).count()) === 1, HUNG_MS)))

  // --- A project without git.
  await page.getByText('beta', { exact: true }).first().click()
  await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
  const notes = page.locator('[data-vc-init]')
  check('a project without git (None) says so, with only Workflow and no Initialise repository… (HI-1905: Git’s)', !!(await lib.until(async () => /has no version control/.test(await text(page.locator('[data-vc-fact]'))) && JSON.stringify(await page.locator('.git-sections [role="tab"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-section')))) === '["workflow"]', HUNG_MS)) && (await notes.count()) === 0, await text(page.locator('.vc-view')))
  check('and has no status bar item', (await item.count()) === 0)
  await shot(page, '5-no-git')
  await page.locator('[data-vc-head] [data-platform="git"]').click()
  check('Git chosen there: Initialise repository…', !!(await lib.until(async () => (await notes.locator('[data-git-init]').count()) === 1, HUNG_MS)), await text(page.locator('.vc-view')))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
