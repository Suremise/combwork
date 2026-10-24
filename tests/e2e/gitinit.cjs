// Initialise repository (#701): a project that isn't a git repository becomes one from its Version Control tab (#1416:
// None's page, under the header), then gets an agent with a worktree straight away, an empty project (an empty first
// commit) too. None's page says the folder has no version control and has an Initialise repository… button; its
// dialog offers a starter .gitignore and, as git has no identity here, asks for the name and email; Initialise makes the
// repository on main with a first commit (the .gitignore and the project's files, never .hive) and saves the identity to
// that repository's config only, not the global one. Git then reads the branch (the project stays None until it is
// switched, #1419), and an agent added in a new
// worktree gets its folder and branch. Git's global config is the suite's own, with no identity (GIT_CONFIG_GLOBAL), and
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

  const { app, page } = await lib.launch({ userData, env: { ...claude, HIVE_API_PORT: lib.port(47877), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const text = (loc) => loc.innerText().catch(() => '')
    // Hive made the project's .hive when it opened the workspace: it must stay out of the first commit.
    check('the project has a .hive', !!(await lib.until(() => fs.existsSync(path.join(proj, '.hive')), HUNG_MS)))

    // --- The Version Control tab of a project without git: None's page, its fact line and the button.
    await page.getByText('fresh', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    const notes = page.locator('[data-vc-init]')
    check('the tab says the folder has no version control, with Initialise repository…', !!(await lib.until(async () => /has no version control/.test(await text(page.locator('[data-vc-fact]'))) && (await notes.locator('[data-git-init]').count()) === 1, HUNG_MS)), await text(page.locator('.vc-view')))
    await notes.locator('[data-git-init]').click()
    const dialog = page.locator('.dialog', { hasText: 'Initialise fresh as a git repository' })
    const form = dialog.locator('[data-git-init-form]')
    check('the dialog says what it does', !!(await lib.until(async () => /on a branch called main, keeps its \.hive out of git/.test(await text(form)), HUNG_MS)), await text(form))
    check('git has no identity here, so it asks for both', (await dialog.locator('#git-init-name').count()) === 1 && (await dialog.locator('#git-init-email').count()) === 1)
    const initialise = dialog.getByRole('button', { name: 'Initialise', exact: true })
    check('Initialise waits for the identity', await initialise.isDisabled())
    await dialog.locator('#git-init-gitignore').selectOption('node')
    await dialog.locator('#git-init-name').fill('Fresh Person')
    await dialog.locator('#git-init-email').fill('1+fresh@users.noreply.github.com')
    await shot(page, '1-dialog')
    await initialise.click()

    // --- The repository: main, one commit with the files and the .gitignore, never .hive or node_modules.
    check('the dialog closes', !!(await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)), await text(dialog))
    check('the folder is a repository on main with a first commit', !!(await lib.until(() => fs.existsSync(path.join(proj, '.git')), HUNG_MS)) && g(proj, 'symbolic-ref', '--short', 'HEAD') === 'main' && g(proj, 'rev-list', '--count', 'HEAD') === '1')
    const files = g(proj, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()
    check('it committed the files and the Node .gitignore, not .hive or node_modules', JSON.stringify(files) === JSON.stringify(['.gitignore', 'package.json', 'src/index.js']), files.join(', '))
    check('the identity is saved to this repository', g(proj, 'config', '--local', 'user.email') === '1+fresh@users.noreply.github.com' && g(proj, 'log', '-1', '--format=%an') === 'Fresh Person')
    check('and not to the global config', fs.readFileSync(globalConfig, 'utf8') === GLOBAL)
    check('git ignores .hive', g(proj, 'status', '--porcelain', '--untracked-files=all') === '')

    // --- Git works at once: it reads the branch, and None's page no longer offers Initialise (the Git sections come
    // with the switch to Git, #1419).
    check('git reads the branch', !!(await lib.until(async () => (await inv('git:summary', proj))?.branch === 'main', HUNG_MS)))
    check("None's page no longer offers Initialise", !!(await lib.until(async () => (await notes.count()) === 0, HUNG_MS)), await text(notes))
    await shot(page, '2-initialised')

    // --- An agent in a new worktree works straight away.
    const info = await lib.until(async () => ((await inv('workspace:get'))?.projects ?? []).find((p) => p.name === 'fresh' && p.isGitRepo) ?? null, HUNG_MS)
    check('the workspace knows it is a repository now', !!info)
    const tree = await lib.addAgent(inv, proj, { name: 'Tree', location: 'new-worktree' }).catch((e) => ({ error: e.message }))
    check('an agent in a new worktree is added', !!tree?.worktree?.path, JSON.stringify(tree))
    const wt = tree?.worktree?.path
    check('its worktree is there, on its own branch, from main', !!wt && fs.existsSync(path.join(wt, 'package.json')) && g(wt, 'symbolic-ref', '--short', 'HEAD') === tree.worktree.branch && g(proj, 'worktree', 'list').includes(path.basename(wt)))
    check('the worktree has no .hive from the project', !!wt && !fs.existsSync(path.join(wt, '.hive', 'sessions.json')))

    // --- An empty project: no starter .gitignore, an empty first commit, and a worktree from it.
    await page.getByText('blank', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    const blankNotes = page.locator('[data-vc-init]')
    check("the empty project's Version Control tab offers Initialise", !!(await lib.until(async () => (await blankNotes.locator('[data-git-init]').count()) === 1, HUNG_MS)), await text(page.locator('.vc-view')))
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
    check('a project inside the workspace repository offers its own', !!(await lib.until(async () => (await parent.locator('[data-git-init]').count()) === 1, HUNG_MS)), await text(parent))
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
    await lateDialog.locator('#git-init-name').fill('Late Person')
    await lateDialog.locator('#git-init-email').fill('3+late@users.noreply.github.com')
    await shot(page, '3-first-commit')
    await firstCommit.click()
    check('Make first commit commits as the identity entered, saved to the repository', !!(await lib.until(async () => (await lateDialog.count()) === 0, HUNG_MS)) && g(late, 'log', '-1', '--format=%an <%ae>') === 'Late Person <3+late@users.noreply.github.com>' && g(late, 'config', '--local', 'user.name') === 'Late Person')
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
