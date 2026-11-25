// Repository health (HI-3473) at the foot of Version Control → Branches & remotes, driven in the window: a project with
// a worktree whose folder was deleted by hand, a lock file left in its git folder, and a remote that deleted a branch
// a local branch tracks. The section counts the first two as it opens; Prune Worktrees… lists the entry ticked and
// drops it (git lists it no more); Remove Stale Locks… shows the lock kept while it is too new, then, once it is old
// enough (the age rule lowered from an hour to its least, 10 s), ticked, and removes it; Fetch with Prune… asks the remote, lists origin/old with the local branch tracking it,
// and drops it (origin/kept stays, and so does the local branch). The programs that may hold a lock are set to none, so another lane's git on the machine can't hold it: the rule itself has
// unit tests (tests/gitHealth.test.ts). Remotes are local bare repositories in the suite's folder, git's global config
// the suite's own. Screenshots of the section and each dialog in both themes. Dev build, throwaway profile and
// workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'githealth-profile')
const ws = path.join(lib.WORK, 'githealth-ws')
const origin = path.join(lib.WORK, 'githealth-origin.git')
const gone = path.join(lib.WORK, 'githealth-gone-wt')
const claudeHome = path.join(lib.WORK, 'githealth-claude-home')
const globalConfig = path.join(lib.WORK, 'githealth-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, origin, gone, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = 1+test@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
  fs.mkdirSync(alpha, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv })
  g(ws, 'init', '-q', '-b', 'main', alpha)
  fs.writeFileSync(path.join(alpha, 'a.txt'), 'a\n')
  g(alpha, 'add', '-A')
  g(alpha, 'commit', '-qm', 'first')
  g(alpha, 'remote', 'add', 'origin', origin)
  g(alpha, 'push', '-q', 'origin', 'main', 'main:refs/heads/old', 'main:refs/heads/kept')
  g(alpha, 'fetch', '-q', 'origin')
  g(alpha, 'branch', '-q', '--track', 'old', 'origin/old')
  g(origin, 'branch', '-q', '-D', 'old')
  // A worktree whose folder is deleted by hand: git keeps its entry.
  g(alpha, 'worktree', 'add', '-q', '-b', 'cw/gone', gone)
  fs.rmSync(gone, { recursive: true, force: true })
  const gitDir = path.join(alpha, '.git')
  const lock = path.join(gitDir, 'index.lock')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, CW_API_PORT: lib.port(47603), GIT_CONFIG_GLOBAL: globalConfig }

  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1300, height: 900 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await inv('advanced:set', 'cw.git.staleLockSeconds', 3600)
    await inv('advanced:set', 'cw.git.processNames', String.raw`^cw-e2e-no-such-program\.exe$`)
    await lib.openWorkspace(inv, page, ws)
    const text = (loc) => loc.innerText().catch(() => '')
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.statusbar [data-git-status]').click()
    const health = page.locator('[data-git-health]')
    const state = (row) => text(health.locator(`[data-health-state="${row}"]`))
    const theme = async (t) => {
      await inv('settings:update', { appearance: { theme: t } })
      await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
    }
    // The lock: too new to be stale until the rule is lowered below.
    fs.writeFileSync(lock, '')
    const reload = () => page.locator('[data-action="reload-health"]').click()

    // --- What it finds as it opens.
    const found = await lib.until(async () => {
      await reload()
      return /1 whose folder is gone/.test(await state('worktrees')) && /in use or too new/.test(await state('locks')) ? true : null
    }, HUNG_MS)
    check('the section counts the gone worktree and the lock, too new yet', !!found, `${await state('worktrees')} | ${await state('locks')}`)
    check('Fetch with Prune is offered for the remote', !!(await lib.until(async () => (await health.locator('[data-action="health-fetch"]').isEnabled()) && /deleted on the remote/.test(await state('fetch')), HUNG_MS)), await state('fetch'))
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await health.screenshot({ path: path.join(lib.WORK, `githealth-1-section-${t}.png`) })
    }
    await theme('dark')

    // --- Prune Worktrees: the entry listed, ticked, dropped.
    await health.locator('[data-action="health-prune"]').click()
    const prune = page.locator('.dialog', { hasText: 'Prune worktree entries' })
    await lib.until(async () => (await prune.locator('[data-health-prune]').count()) === 1, HUNG_MS)
    const entry = prune.locator('[data-health-prune]')
    check('the entry is listed by its folder, ticked', (await entry.isChecked()) && (await text(prune)).toLowerCase().includes(gone.toLowerCase()), await text(prune))
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await prune.screenshot({ path: path.join(lib.WORK, `githealth-2-prune-${t}.png`) })
    }
    await theme('dark')
    await prune.getByRole('button', { name: 'Prune Ticked', exact: true }).click()
    const pruned = await lib.until(async () => ((await prune.count()) === 0 && !g(alpha, 'worktree', 'list', '--porcelain').toLowerCase().includes('githealth-gone-wt') ? true : null), HUNG_MS)
    check('…dropped: git lists it no more, and the section says none', !!pruned && !!(await lib.until(async () => /None whose folder is gone/.test(await state('worktrees')), HUNG_MS)), `${g(alpha, 'worktree', 'list')} | ${await state('worktrees')}`)
    // git takes a worktree at that place again.
    g(alpha, 'worktree', 'add', '-q', gone, 'cw/gone')
    check('a worktree can be made at its place again', fs.existsSync(path.join(gone, 'a.txt')))
    g(alpha, 'worktree', 'remove', gone)

    // --- Remove Stale Locks: kept while too new, then stale, ticked, removed.
    await health.locator('[data-action="health-locks"]').click()
    let dialog = page.locator('.dialog', { hasText: 'Remove stale lock files' })
    await lib.until(async () => (await dialog.locator('[data-health-lock="index.lock"]').count()) === 1, HUNG_MS)
    check('a lock too new is listed, kept, with why', (await dialog.locator('[data-health-lock="index.lock"]').isDisabled()) && /less than 3,600 seconds old/.test(await text(dialog)), await text(dialog))
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await inv('advanced:set', 'cw.git.staleLockSeconds', 10)
    const stale = await lib.until(async () => {
      await reload()
      return /1 stale, of 1/.test(await state('locks')) ? true : null
    }, HUNG_MS)
    check('once old enough, it is stale', !!stale, await state('locks'))
    await health.locator('[data-action="health-locks"]').click()
    dialog = page.locator('.dialog', { hasText: 'Remove stale lock files' })
    await lib.until(async () => (await dialog.locator('[data-health-lock="index.lock"]').count()) === 1, HUNG_MS)
    check('…listed ticked', await dialog.locator('[data-health-lock="index.lock"]').isChecked())
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await dialog.screenshot({ path: path.join(lib.WORK, `githealth-3-locks-${t}.png`) })
    }
    await theme('dark')
    await dialog.getByRole('button', { name: 'Remove Ticked', exact: true }).click()
    check('…removed, and git works again', !!(await lib.until(async () => ((await dialog.count()) === 0 && !fs.existsSync(lock) ? true : null), HUNG_MS)) && (g(alpha, 'add', '-A'), true))

    // --- Fetch with Prune: origin/old listed with the branch tracking it, then dropped.
    await health.locator('[data-action="health-fetch"]').click()
    const fetch = page.locator('.dialog', { hasText: 'Fetch with prune' })
    await lib.until(async () => (await fetch.locator('[data-health-fetch-branch="origin/old"]').count()) === 1, HUNG_MS)
    check('origin/old listed, the local branch tracking it named', /old tracks it/.test(await text(fetch.locator('[data-health-fetch-branch="origin/old"]'))) && (await fetch.locator('[data-health-fetch-branch]').count()) === 1, await text(fetch))
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await fetch.screenshot({ path: path.join(lib.WORK, `githealth-4-fetch-${t}.png`) })
    }
    await theme('dark')
    await fetch.getByRole('button', { name: 'Fetch and Prune', exact: true }).click()
    const remotes = () => g(alpha, 'branch', '-r')
    check('…dropped; origin/kept and the local branch stay', !!(await lib.until(async () => ((await fetch.count()) === 0 && !remotes().includes('origin/old') ? true : null), HUNG_MS)) && remotes().includes('origin/kept') && g(alpha, 'branch', '--list', 'old').includes('old'), remotes())
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
