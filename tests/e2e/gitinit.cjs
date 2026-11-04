// Initialise repository (#701): a project that isn't a git repository becomes one from its Version Control tab (#1416;
// HI-1905: Git chosen before the folder is a repository, Git's page offering only Initialise repository…), then gets an
// agent with a worktree straight away, an empty project (an empty first commit) too. None's page says the folder has no
// version control and offers no Initialise; Git's page does. Its first Initialise fails (HIVE_TEST_FAIL_IPC): the
// failure stays on Git's page and nothing is made or switched. Its dialog offers a starter .gitignore and, as git has no identity here, asks for the name and email; Initialise makes the
// repository on main with a first commit (the .gitignore and the project's files, never .combwork) and saves the identity to
// that repository's config only, not the global one. The project then switches to Git (HI-1905: it was chosen), its
// sections and its workflow shown, and an agent added in a new worktree gets its folder and branch. Inside another
// repository, Git's page offers that one (its warning, cancelled here) or one of its own; an init that stops before its
// first commit stays on Git's page, with Make first commit…. Git's global config is the suite's own, with no identity (GIT_CONFIG_GLOBAL), and
// no system config (GIT_CONFIG_NOSYSTEM). Dev build, throwaway profile and workspace.
// Dev build only (#1580): 0.9 worktrees on purpose: Tree, Blank Tree and Late Tree are 0.9 worktree agents
// (agents:testLegacy, refused by a packaged build), checking a worktree from a repository Hive initialised.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'gitinit-profile')
const ws = path.join(lib.WORK, 'gitinit-ws')
const claudeHome = path.join(lib.WORK, 'gitinit-claude-home')
const globalConfig = path.join(lib.WORK, 'gitinit-gitconfig')
const proj = path.join(ws, 'fresh')
// An empty project: its first commit is an empty one.
const blank = path.join(ws, 'blank')
// A project that ends up inside another repository (the workspace, made one late in the suite).
const late = path.join(ws, 'late')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `gitinit-${name}.png`) })

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  // The suite's own global git config, with no identity in it: the dialog has to ask for one.
  const GLOBAL = '[core]\n\tautocrlf = false\n'
  fs.writeFileSync(globalConfig, GLOBAL)
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
  fs.mkdirSync(blank, { recursive: true })
  fs.mkdirSync(late, { recursive: true })
  fs.writeFileSync(path.join(late, 'notes.txt'), 'late\n')
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'package.json'), '{ "name": "fresh" }\n')
  fs.writeFileSync(path.join(proj, 'src', 'index.js'), 'console.log(1)\n')
  fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  const claude = lib.fakeClaude(userData, claudeHome, [proj, blank, late])

  const { app, page } = await lib.launch({ userData, env: { ...claude, HIVE_API_PORT: lib.port(47877), HIVE_TEST_FAIL_IPC: 'git:init*1', GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const text = (loc) => loc.innerText().catch(() => '')
    // Hive made the project's .combwork when it opened the workspace: it must stay out of the first commit.
    check('the project has a .combwork', !!(await lib.until(() => fs.existsSync(path.join(proj, '.combwork')), HUNG_MS)))

    // --- The Version Control tab of a project without git: None's page has no Initialise; Git's page has it (HI-1905).
    await page.getByText('fresh', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    const head = page.locator('[data-vc-head]')
    const notes = page.locator('[data-vc-init]')
    const isGit = async (dir) => (await inv('workflow:form', dir)).platform === 'git'
    check("the tab says the folder has no version control, and None's page offers no Initialise", !!(await lib.until(async () => /has no version control/.test(await text(page.locator('[data-vc-fact]'))) && (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1, HUNG_MS)) && (await notes.count()) === 0, await text(page.locator('.vc-view')))
    await head.locator('[data-platform="git"]').click()
    check("Git chosen: its page has Initialise repository…", !!(await lib.until(async () => (await notes.locator('[data-git-init]').count()) === 1, HUNG_MS)), await text(page.locator('.vc-view')))
    const dialog = page.locator('.dialog', { hasText: 'Initialise fresh as a git repository' })
    const form = dialog.locator('[data-git-init-form]')
    const fill = async () => {
      await notes.locator('[data-git-init]').click()
      await lib.until(async () => (await form.count()) === 1, HUNG_MS)
      await dialog.locator('#git-init-gitignore').selectOption('node')
      await dialog.locator('#git-init-name').fill('Fresh Person')
      await dialog.locator('#git-init-email').fill('1+fresh@users.noreply.github.com')
    }
    // A failed init (HIVE_TEST_FAIL_IPC: the first git:init fails before it does anything).
    await fill()
    await dialog.getByRole('button', { name: 'Initialise', exact: true }).click()
    check('a failed init: the dialog says so', !!(await lib.until(async () => /git:init failed/.test(await text(dialog.locator('.dialog-error'))), HUNG_MS)), await text(dialog))
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    check("…closed, the failure stays on Git's page", !!(await lib.until(async () => (await dialog.count()) === 0 && /git:init failed/.test(await text(notes.locator('[data-vc-init-error]'))), HUNG_MS)), await text(notes))
    check('…and nothing changed: no repository, still None', !fs.existsSync(path.join(proj, '.git')) && !(await isGit(proj)))
    await shot(page, '0-failed')
    await notes.locator('[data-git-init]').click()
    check('the dialog says what it does', !!(await lib.until(async () => /on a branch called main, keeps its \.combwork out of git/.test(await text(form)), HUNG_MS)), await text(form))
    check('git has no identity here, so it asks for both', (await dialog.locator('#git-init-name').count()) === 1 && (await dialog.locator('#git-init-email').count()) === 1)
    const initialise = dialog.getByRole('button', { name: 'Initialise', exact: true })
    check('Initialise waits for the identity', await initialise.isDisabled())
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await fill()
    await shot(page, '1-dialog')
    await initialise.click()

    // --- The repository: main, one commit with the files and the .gitignore, never .combwork or node_modules.
    check('the dialog closes', !!(await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)), await text(dialog))
    check('the folder is a repository on main with a first commit', !!(await lib.until(() => fs.existsSync(path.join(proj, '.git')), HUNG_MS)) && g(proj, 'symbolic-ref', '--short', 'HEAD') === 'main' && g(proj, 'rev-list', '--count', 'HEAD') === '1')
    const files = g(proj, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()
    check('it committed the files and the Node .gitignore, not .combwork or node_modules', JSON.stringify(files) === JSON.stringify(['.gitignore', 'package.json', 'src/index.js']), files.join(', '))
    check('the identity is saved to this repository', g(proj, 'config', '--local', 'user.email') === '1+fresh@users.noreply.github.com' && g(proj, 'log', '-1', '--format=%an') === 'Fresh Person')
    check('and not to the global config', fs.readFileSync(globalConfig, 'utf8') === GLOBAL)
    check('git ignores .combwork', g(proj, 'status', '--porcelain', '--untracked-files=all') === '')

    // --- Git works at once: it reads the branch, and the project is Git, as chosen (HI-1905), with its sections and its
    // workflow, no preset chosen yet (the presets notice offers them).
    check('git reads the branch', !!(await lib.until(async () => (await inv('git:summary', proj))?.branch === 'main', HUNG_MS)))
    const gitSections = () => page.locator('.git-sections [role="tab"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-section')))
    check("the project switched to Git: Git's sections and its workflow (no preset chosen yet), no Initialise", !!(await lib.until(async () => (await isGit(proj)) && (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1 && (await gitSections()).includes('changes') && (await page.locator('[data-action="vc-workflow"]').innerText().catch(() => '')).trim() === 'Workflow: Git · no preset chosen' && (await notes.count()) === 0, HUNG_MS)), `${JSON.stringify(await gitSections())} ${await text(page.locator('.vc-view'))}`)
    check('…and the notice that it is still treated as None goes', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'Version control changed in fresh' }).count()) === 0, HUNG_MS)))
    await shot(page, '2-initialised')

    // --- An agent in a new worktree works straight away.
    const info = await lib.until(async () => ((await inv('workspace:get'))?.projects ?? []).find((p) => p.name === 'fresh' && p.isGitRepo) ?? null, HUNG_MS)
    check('the workspace knows it is a repository now', !!info)
    const tree = await lib.addAgent(inv, proj, { name: 'Tree', location: 'new-worktree' }).catch((e) => ({ error: e.message }))
    check('an agent in a new worktree is added', !!tree?.worktree?.path, JSON.stringify(tree))
    const wt = tree?.worktree?.path
    check('its worktree is there, on its own branch, from main', !!wt && fs.existsSync(path.join(wt, 'package.json')) && g(wt, 'symbolic-ref', '--short', 'HEAD') === tree.worktree.branch && g(proj, 'worktree', 'list').includes(path.basename(wt)))
    check('the worktree has no .combwork from the project', !!wt && !fs.existsSync(path.join(wt, '.combwork', 'sessions.json')))

    // --- An empty project: no starter .gitignore, an empty first commit, and a worktree from it.
    await page.getByText('blank', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    const blankNotes = page.locator('[data-vc-init]')
    await lib.until(async () => (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1, HUNG_MS)
    await head.locator('[data-platform="git"]').click()
    check("the empty project's Git page offers Initialise", !!(await lib.until(async () => (await blankNotes.locator('[data-git-init]').count()) === 1, HUNG_MS)), await text(page.locator('.vc-view')))
    await blankNotes.locator('[data-git-init]').click()
    const blankDialog = page.locator('.dialog', { hasText: 'Initialise blank as a git repository' })
    check('it says the first commit is an empty one', !!(await lib.until(async () => /an empty first commit/.test(await text(blankDialog.locator('[data-git-init-form]'))), HUNG_MS)), await text(blankDialog))
    await blankDialog.locator('#git-init-gitignore').selectOption('none')
    await blankDialog.locator('#git-init-name').fill('Blank Person')
    await blankDialog.locator('#git-init-email').fill('2+blank@users.noreply.github.com')
    await blankDialog.getByRole('button', { name: 'Initialise', exact: true }).click()
    check('the empty project gets an empty first commit on main', !!(await lib.until(async () => (await blankDialog.count()) === 0 && fs.existsSync(path.join(blank, '.git')), HUNG_MS)) && g(blank, 'symbolic-ref', '--short', 'HEAD') === 'main' && g(blank, 'ls-tree', '-r', '--name-only', 'HEAD') === '' && !fs.existsSync(path.join(blank, '.gitignore')))
    const blankTree = await lib.addAgent(inv, blank, { name: 'Blank Tree', location: 'new-worktree' }).catch((e) => ({ error: e.message }))
    check('an agent in a new worktree of the empty project is added', !!blankTree?.worktree?.path && fs.existsSync(blankTree.worktree.path) && g(blank, 'worktree', 'list').includes(path.basename(blankTree.worktree.path)), JSON.stringify(blankTree))

    // --- Inside another repository whose identity comes from a conditional include matching only it (#701 round 2):
    // the dialog doesn't take that identity for the new repository's; with nothing entered it makes the repository and
    // stops before committing, then stays open to ask for the identity and make the first commit.
    const outerId = path.join(lib.WORK, 'gitinit-outer-identity.gitconfig')
    fs.writeFileSync(outerId, '[user]\n\tname = Outer Person\n\temail = outer@example.com\n')
    fs.writeFileSync(globalConfig, `${GLOBAL}[includeIf "gitdir/i:${ws.replace(/\\/g, '/')}/.git"]\n\tpath = ${outerId.replace(/\\/g, '/')}\n`)
    g(ws, 'init', '-q', '-b', 'main')
    await page.getByText('late', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    const parent = page.locator('[data-git-parent]')
    await lib.until(async () => (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1, HUNG_MS)
    check("inside the workspace repository, None's page offers nothing", (await notes.count()) === 0)
    await head.locator('[data-platform="git"]').click()
    check("Git's page: that repository, or one of its own", !!(await lib.until(async () => (await parent.locator('[data-git-init]').count()) === 1 && (await parent.locator('[data-action="vc-use-parent"]').count()) === 1 && (await text(parent)).includes(`inside the Git repository at ${ws}`) && (await text(parent)).includes('Initialise its own repository… makes this folder a Git repository of its own'), HUNG_MS)), await text(parent))
    await shot(page, '2-parent')
    await parent.locator('[data-action="vc-use-parent"]').click()
    const useWarning = page.locator('.dialog', { hasText: 'Switch late to Git?' })
    check('Use that repository… warns first', !!(await lib.until(async () => (await useWarning.count()) === 1, HUNG_MS)))
    await page.keyboard.press('Escape')
    check('…cancelled: still None, still Git’s page', !!(await lib.until(async () => (await useWarning.count()) === 0 && (await parent.count()) === 1, HUNG_MS)) && !(await isGit(late)))
    await parent.locator('[data-git-init]').click()
    const lateDialog = page.locator('.dialog', { hasText: 'late' })
    check('it names the repository around it', !!(await lib.until(async () => (await text(lateDialog.locator('[data-git-init-nested]'))).includes(ws), HUNG_MS)), await text(lateDialog))
    check("the outer repository's conditional identity isn't taken for its own: the fields are there", (await lateDialog.locator('#git-init-name').count()) === 1 && (await lateDialog.locator('#git-init-email').count()) === 1)
    const lateInit = lateDialog.getByRole('button', { name: 'Initialise', exact: true })
    check('Initialise waits for the confirmation', await lateInit.isDisabled())
    await lateDialog.locator('[data-git-init-nested] input').check()
    await lateInit.click()
    const firstCommit = lateDialog.getByRole('button', { name: 'Make first commit', exact: true })
    check('with no identity for it, it stops before the first commit and the dialog stays, saying so', !!(await lib.until(async () => (await firstCommit.count()) === 1 && /git has no name or email to make the first commit as here/.test(await text(lateDialog.locator('.dialog-error'))), HUNG_MS)), await text(lateDialog))
    check('the repository is made, with no commit', fs.existsSync(path.join(late, '.git')) && !g(late, 'rev-list', '--all'))
    check('the fields are needed now', (await lateDialog.locator('#git-init-name').count()) === 1 && (await firstCommit.isDisabled()))
    // Closed part way: still Git's page (a repository, no commit yet), its first commit offered, nothing switched.
    await lateDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    check("closed part way: Git's page offers Make first commit…, the project still None", !!(await lib.until(async () => (await lateDialog.count()) === 0 && /no first commit yet/.test(await text(notes)) && (await text(notes.locator('[data-git-init]'))).includes('Make first commit…'), HUNG_MS)) && !(await isGit(late)), await text(notes))
    await notes.locator('[data-git-init]').click()
    await lib.until(async () => (await firstCommit.count()) === 1, HUNG_MS)
    await lateDialog.locator('#git-init-name').fill('Late Person')
    await lateDialog.locator('#git-init-email').fill('3+late@users.noreply.github.com')
    await shot(page, '3-first-commit')
    await firstCommit.click()
    check('Make first commit commits as the identity entered, saved to the repository', !!(await lib.until(async () => (await lateDialog.count()) === 0, HUNG_MS)) && g(late, 'log', '-1', '--format=%an <%ae>') === 'Late Person <3+late@users.noreply.github.com>' && g(late, 'config', '--local', 'user.name') === 'Late Person')
    check('…and the project switches to Git', !!(await lib.until(async () => (await isGit(late)) && (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1, HUNG_MS)))
    const lateTree = await lib.addAgent(inv, late, { name: 'Late Tree', location: 'new-worktree' }).catch((e) => ({ error: e.message }))
    check('and an agent in a new worktree of it is added', !!lateTree?.worktree?.path && fs.existsSync(path.join(lateTree.worktree.path, 'notes.txt')), JSON.stringify(lateTree))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
