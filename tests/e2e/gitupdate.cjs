// Update from <target> (HI-1180): a project on main (its target: no workflow target set) with three branches that each
// have a commit of their own and lack main's newest: feature, checked out in a worktree (as a slot's line is); loose,
// checked out nowhere; clash, whose commit changes the same line as main's. Version Control → Branches & remotes shows
// each one's missing commits and an Update button (none on main). Update on feature: its dialog says where it runs and
// that a conflict is undone; Merge (the default) merges main in there, said in a notice, and the row's count goes.
// Rebase on loose: rebased in a temporary worktree, which is gone after. Merge on clash: the conflict is undone at once,
// the dialog naming the file, clash as it was. fresh, checked out in another worktree with nothing of its own (behind
// only, HR4's round 1): Update, its one choice a fast-forward. Screenshots of the dialog in both themes. Dev build, throwaway profile and
// workspace; git's global config the suite's own.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'gitupdate-profile')
const ws = path.join(lib.WORK, 'gitupdate-ws')
const wt = path.join(lib.WORK, 'gitupdate-feature')
const freshWt = path.join(lib.WORK, 'gitupdate-fresh')
const claudeHome = path.join(lib.WORK, 'gitupdate-claude-home')
const globalConfig = path.join(lib.WORK, 'gitupdate-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, wt, freshWt, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = 1+test@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
  const commitOn = (branch, file, body) => {
    // main has no commit to check out yet the first time: it is the branch already.
    if (g(alpha, 'symbolic-ref', '--short', 'HEAD') !== branch) g(alpha, 'checkout', '-q', branch)
    fs.writeFileSync(path.join(alpha, file), body)
    g(alpha, 'add', '-A')
    g(alpha, 'commit', '-qm', `${branch}: ${file}`)
  }
  const isIn = (commit, branch) => {
    try {
      g(alpha, 'merge-base', '--is-ancestor', commit, branch)
      return true
    } catch {
      return false
    }
  }
  fs.mkdirSync(alpha, { recursive: true })
  g(ws, 'init', '-q', '-b', 'main', alpha)
  commitOn('main', 'shared.txt', 'one\n')
  // fresh has nothing of its own (behind only), checked out in a worktree: in use, as a card's new line is.
  for (const b of ['feature', 'loose', 'clash', 'fresh']) g(alpha, 'branch', b)
  commitOn('feature', 'feature.txt', 'feature\n')
  commitOn('loose', 'loose.txt', 'loose\n')
  commitOn('clash', 'shared.txt', 'clash\n')
  commitOn('main', 'shared.txt', 'main\n')
  g(alpha, 'worktree', 'add', '-q', wt, 'feature')
  g(alpha, 'worktree', 'add', '-q', freshWt, 'fresh')
  const main = g(alpha, 'rev-parse', 'main')
  const clashWas = g(alpha, 'rev-parse', 'clash')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, HIVE_API_PORT: lib.port(47813), GIT_CONFIG_GLOBAL: globalConfig }

  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1300, height: 900 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.openWorkspace(inv, page, ws)
    const text = (loc) => loc.innerText().catch(() => '')
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.statusbar [data-git-status]').click()
    const branches = page.locator('[data-git-branches]')
    await lib.until(async () => (await text(branches.locator('[data-git-head]'))) === 'main', HUNG_MS)
    const theme = async (t) => {
      await inv('settings:update', { appearance: { theme: t } })
      await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
    }
    const row = (b) => branches.locator(`[data-branch="${b}"]`)
    const update = (b) => row(b).locator('[data-action="update-branch"]')
    const dialog = (b) => page.locator('.dialog', { hasText: `Update ${b} from main` })

    // --- Each branch behind main says how far, with Update; main itself has none.
    check('each branch behind main says what it lacks, with Update', !!(await lib.until(async () => (await update('feature').count()) === 1 && (await update('loose').count()) === 1 && (await update('clash').count()) === 1, HUNG_MS)) && /1 commit of main it hasn't/.test(await text(row('feature'))), await text(row('feature')))
    check('…none on main', (await update('main').count()) === 0)
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await branches.locator('.git-rows').first().screenshot({ path: path.join(lib.WORK, `gitupdate-0-rows-${t}.png`) })
    }

    // --- feature, in its worktree: the dialog says where and what; Merge brings main in there.
    await update('feature').click()
    const fd = dialog('feature')
    await lib.until(async () => (await fd.count()) === 1, HUNG_MS)
    const about = await text(fd)
    check('the dialog: the counts, where it runs, and that a conflict is undone', /main has 1 commit feature hasn't; feature has 1 commit of its own\./.test(about) && about.includes(`It runs in ${wt}, where feature is checked out.`) && /A conflict is undone at once, leaving feature as it was\./.test(about), about)
    check('…Merge chosen to start with, its note saying one merge commit', (await fd.locator('select').inputValue()) === 'merge' && /One merge commit joins main's commits to feature's/.test(await text(fd)), await text(fd))
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await fd.screenshot({ path: path.join(lib.WORK, `gitupdate-1-dialog-${t}.png`) })
    }
    await fd.locator('select').selectOption('rebase')
    check('…Rebase says its commit is replayed as a new one', /feature's commit is replayed on top of main, as new commits\./.test(await text(fd)), await text(fd))
    await theme('dark')
    await fd.screenshot({ path: path.join(lib.WORK, 'gitupdate-2-rebase-dark.png') })
    await fd.locator('select').selectOption('merge')
    await fd.getByRole('button', { name: 'Update', exact: true }).click()
    const merged = page.locator('.toast', { hasText: /Merged main into feature \([0-9a-f]{7}\)\./ })
    check('Merge: main merged into feature, said in a notice', !!(await lib.until(async () => (await merged.count()) >= 1 && (await fd.count()) === 0, HUNG_MS)) && isIn(main, 'feature') && g(wt, 'log', '-1', '--format=%s') === 'Merge main into feature', g(wt, 'log', '-2', '--format=%s'))
    check('…and the row has nothing to update any more', !!(await lib.until(async () => (await update('feature').count()) === 0, HUNG_MS)), await text(row('feature')))

    // --- loose, checked out nowhere: Rebase, in a temporary worktree removed after.
    await update('loose').click()
    const ld = dialog('loose')
    await lib.until(async () => (await ld.count()) === 1, HUNG_MS)
    check('loose: checked out nowhere, updated in a temporary folder', /loose is checked out nowhere: Combwork updates it in a temporary folder, removed after\./.test(await text(ld)), await text(ld))
    await ld.locator('select').selectOption('rebase')
    await ld.getByRole('button', { name: 'Update', exact: true }).click()
    check('Rebase: loose replayed onto main', !!(await lib.until(async () => (await page.locator('.toast', { hasText: /Rebased loose's 1 commit onto main/ }).count()) >= 1, HUNG_MS)) && g(alpha, 'rev-parse', 'loose~1') === main)
    check('…the temporary worktree gone, the project folder still on main', !g(alpha, 'worktree', 'list', '--porcelain').split('\n').some((l) => /^worktree .*update-[0-9a-f]{8}$/.test(l)) && g(alpha, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main')

    // --- clash: the conflict is undone at once, naming its file; clash as it was.
    await update('clash').click()
    const cd = dialog('clash')
    await lib.until(async () => (await cd.count()) === 1, HUNG_MS)
    await cd.getByRole('button', { name: 'Update', exact: true }).click()
    const error = cd.locator('.dialog-error')
    check('a conflict: undone, the dialog naming the file', !!(await lib.until(async () => /Merging clash with main stopped at a conflict in shared\.txt, so it was undone: clash is as it was\./.test(await text(error)), HUNG_MS)), await text(error))
    check('…clash as it was, the project folder clean', g(alpha, 'rev-parse', 'clash') === clashWas && g(alpha, 'status', '--porcelain') === '' && !fs.existsSync(path.join(alpha, '.git', 'MERGE_HEAD')))
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await cd.screenshot({ path: path.join(lib.WORK, `gitupdate-3-conflict-${t}.png`) })
    }
    await page.keyboard.press('Escape')
    await lib.until(async () => (await cd.count()) === 0, HUNG_MS)

    // --- fresh, behind only (HR4's round 1, finding 3): Update fast-forwards it, the only choice.
    await update('fresh').click()
    const frd = dialog('fresh')
    await lib.until(async () => (await frd.count()) === 1, HUNG_MS)
    const choices = await frd.locator('select option').allInnerTexts()
    check('a branch with nothing of its own has Update, its one choice a fast-forward', JSON.stringify(choices) === JSON.stringify(['Fast-forward to main']) && /fresh has no commits of its own, so it simply moves forward to main/.test(await text(frd)), JSON.stringify({ choices, text: await text(frd) }))
    await frd.getByRole('button', { name: 'Update', exact: true }).click()
    check('…fast-forwarded to main', !!(await lib.until(async () => (await page.locator('.toast', { hasText: /Fast-forwarded fresh to main/ }).count()) >= 1, HUNG_MS)) && g(alpha, 'rev-parse', 'fresh') === g(alpha, 'rev-parse', 'refs/heads/main'))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
