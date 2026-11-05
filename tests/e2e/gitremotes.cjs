// Remotes in the Git view (#1385, Darren's backup remote on his NAS): a project with origin and a second remote, backup.
// Push to… backup, all branches and tags: everything goes there, and what main tracks is unchanged (Push still goes to
// origin). Track… main to backup/main: Push then goes to backup. Track… a branch to a remote branch not there yet: the
// form says it pushes it there first, and does. Stop tracking clears it. Rename backup to nas: the branches tracking it
// follow. Remove nas: the confirm names the branches that stop tracking it, and they do; the remote's own branches are
// untouched. Remotes are local bare repositories in the suite's folder (never a real remote), git's global config is
// the suite's own (GIT_CONFIG_GLOBAL). Screenshots of the dialogs in both themes, and Push to… in German. Dev build,
// throwaway profile and workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'gitremotes-profile')
const ws = path.join(lib.WORK, 'gitremotes-ws')
const origin = path.join(lib.WORK, 'gitremotes-origin.git')
const backup = path.join(lib.WORK, 'gitremotes-backup.git')
const claudeHome = path.join(lib.WORK, 'gitremotes-claude-home')
const globalConfig = path.join(lib.WORK, 'gitremotes-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `gitremotes-${name}.png`) })

;(async () => {
  for (const d of [userData, ws, origin, backup, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = 1+test@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
  const commit = (file) => {
    fs.writeFileSync(path.join(alpha, file), `${file}\n`)
    g(alpha, 'add', '-A')
    g(alpha, 'commit', '-qm', `add ${file}`)
  }
  const upstreamOf = (branch) => g(alpha, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`)
  const has = (repo, ref) => {
    try {
      return g(repo, 'rev-parse', '--verify', '-q', ref)
    } catch {
      return ''
    }
  }
  fs.mkdirSync(alpha, { recursive: true })
  for (const r of [origin, backup]) execFileSync('git', ['init', '-q', '--bare', '-b', 'main', r], { env: gitEnv })
  g(ws, 'init', '-q', '-b', 'main', alpha)
  commit('a.txt')
  g(alpha, 'remote', 'add', 'origin', origin)
  g(alpha, 'push', '-q', '-u', 'origin', 'main')
  g(alpha, 'remote', 'add', 'backup', backup)
  g(alpha, 'branch', 'feature/x')
  g(alpha, 'tag', 'v1')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, CW_API_PORT: lib.port(47848), GIT_CONFIG_GLOBAL: globalConfig }

  {
    const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1500, height: 900 } })
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

      // --- Push to… this branch (main), the folder switched to feature/x in a terminal before Push is clicked: main goes,
      // as the form named it, never the branch checked out by then (HR5's round 1).
      await branches.locator('[data-action="push-to"]').click()
      const pushOne = page.locator('.dialog', { hasText: 'Push to a remote' })
      await lib.until(async () => (await pushOne.count()) === 1, HUNG_MS)
      check('Push to… names this branch: main', /This branch \(main\)/.test(await text(pushOne.locator('#git-form-scope'))), await text(pushOne))
      g(alpha, 'checkout', '-q', 'feature/x')
      await pushOne.getByRole('button', { name: 'Push', exact: true }).click()
      check('…pushes main, as it named, even with feature/x checked out meanwhile', !!(await lib.until(async () => (await pushOne.count()) === 0, HUNG_MS)) && has(backup, 'main') === has(alpha, 'main') && !has(backup, 'feature/x'), JSON.stringify({ main: has(backup, 'main'), x: has(backup, 'feature/x') }))
      // The view reads git again after the push (feature/x, as the terminal left it); back on main, read again.
      await lib.until(async () => (await text(branches.locator('[data-git-head]'))) === 'feature/x', HUNG_MS)
      g(alpha, 'checkout', '-q', 'main')
      await branches.locator('[data-action="reload-branches"]').click()
      await lib.until(async () => (await text(branches.locator('[data-git-head]'))) === 'main', HUNG_MS)

      // --- Push to… backup, all branches and tags; main's upstream stays origin/main.
      await branches.locator('[data-action="push-to"]').click()
      const pushTo = page.locator('.dialog', { hasText: 'Push to a remote' })
      await lib.until(async () => (await pushTo.count()) === 1, HUNG_MS)
      check('Push to… offers the other remote first, and this branch', (await pushTo.locator('#git-form-remote').inputValue()) === 'backup' && (await pushTo.locator('#git-form-scope').inputValue()) === 'branch' && /without changing what main tracks/.test(await text(pushTo)), await text(pushTo))
      await pushTo.locator('#git-form-scope').selectOption('all')
      await shot(page, '1-push-to-dark')
      await theme('light')
      await shot(page, '1-push-to-light')
      await theme('dark')
      await pushTo.getByRole('button', { name: 'Push', exact: true }).click()
      const pushed = await lib.until(async () => (await pushTo.count()) === 0, HUNG_MS)
      check('…pushes every branch and tag to backup', !!pushed && has(backup, 'main') === has(alpha, 'main') && has(backup, 'feature/x') === has(alpha, 'feature/x') && has(backup, 'refs/tags/v1') === has(alpha, 'refs/tags/v1'))
      const notice = page.locator('.toast', { hasText: 'Pushed every branch and tag to backup' })
      check('…and the notice says what happened to each branch, by name', !!(await lib.until(async () => /Pushed: feature\/x\.\s+Already up to date: main\.\s+Tags pushed: v1\./.test(await text(notice)), HUNG_MS)), await text(notice))
      await shot(page, '1-pushed-all-dark')
      check('…and main still tracks origin/main', upstreamOf('main') === 'origin/main' && (await text(branches.locator('[data-git-upstream]'))).includes('origin/main'), upstreamOf('main'))

      // --- Track… main to backup/main: Push goes there from now on.
      const mainRow = branches.locator('[data-branch="main"]')
      await mainRow.locator('[data-action="track"]').click()
      const track = page.locator('.dialog', { hasText: 'What main tracks' })
      await lib.until(async () => (await track.count()) === 1, HUNG_MS)
      await track.locator('#git-form-remote').selectOption('backup')
      // The form reads the view's info as it is now: the push's remote branches once their read lands.
      check('Track… names the remote branch, the same name by default, and says nothing of pushing for one that is there', (await track.locator('#git-form-branch').inputValue()) === 'main' && !!(await lib.until(async () => (await track.locator('.git-form-note').count()) === 0, HUNG_MS)), await text(track))
      await track.getByRole('button', { name: 'Track', exact: true }).click()
      check('…main tracks backup/main', !!(await lib.until(async () => upstreamOf('main') === 'backup/main' && (await text(branches.locator('[data-git-upstream]'))).includes('backup/main'), HUNG_MS)), upstreamOf('main'))
      commit('b.txt')
      await branches.getByRole('button', { name: 'Push', exact: true }).click()
      check('…and Push goes to backup now, not origin', !!(await lib.until(() => has(backup, 'main') === has(alpha, 'main'), HUNG_MS)) && has(origin, 'main') !== has(alpha, 'main'))

      // --- Track… feature/x to a branch origin hasn't got: said, then pushed there first.
      const featureRow = branches.locator('[data-branch="feature/x"]')
      await featureRow.locator('[data-action="track"]').click()
      const trackX = page.locator('.dialog', { hasText: 'What feature/x tracks' })
      await lib.until(async () => (await trackX.count()) === 1, HUNG_MS)
      await trackX.locator('#git-form-remote').selectOption('origin')
      check('Track… to a remote branch not there yet says it pushes it there first', !!(await lib.until(async () => /origin has no feature\/x yet, as of the last fetch: Track pushes feature\/x there first \(never forced\)\./.test(await text(trackX)), HUNG_MS)), await text(trackX))
      await shot(page, '2-track-dark')
      await trackX.getByRole('button', { name: 'Track', exact: true }).click()
      check('…pushes it there and tracks it', !!(await lib.until(() => upstreamOf('feature/x') === 'origin/feature/x', HUNG_MS)) && has(origin, 'feature/x') === has(alpha, 'feature/x'))

      // --- Rows with a remote's actions (Track…, Stop tracking) beside a long branch tracking origin (HR5's HI-1897
      // round 1): every row's time and actions whole, inside its row and lined up, Switch where it can be clicked, at
      // this width and a narrow one.
      const long = 'cw/HI/HI-9999-a-branch-name-long-enough-to-crowd-its-row-out-of-its-own-room'
      g(alpha, 'branch', long, 'main')
      g(alpha, 'branch', `--set-upstream-to=origin/main`, long)
      await page.locator('[data-action="reload-branches"]').click()
      await lib.until(async () => (await branches.locator(`[data-branch="${long}"] [data-action="untrack"]`).count()) === 1, HUNG_MS)
      const rowsFit = () =>
        branches.locator('.git-rows', { has: page.locator('.git-row.git-branch') }).first().evaluate((list) => {
          const box = (e) => e.getBoundingClientRect()
          const out = [...list.querySelectorAll('.git-row.git-branch:not(.remote)')].map((r) => {
            const rb = box(r)
            const tail = r.querySelector('.git-row-tail')
            const parts = [...(tail?.querySelectorAll('button, .git-meta') ?? [])].map(box)
            const sw = tail?.lastElementChild ? box(tail.lastElementChild) : null
            const btn = tail?.lastElementChild?.querySelector('button')
            const visible = btn && getComputedStyle(btn.closest('.git-switch-slot') ?? btn).visibility !== 'hidden'
            const hit = visible ? document.elementFromPoint(sw.left + sw.width / 2, sw.top + sw.height / 2) : null
            return { name: r.dataset.branch, whole: !!tail && parts.every((b) => b.left >= rb.left - 0.5 && b.right <= rb.right + 0.5), switchRight: sw ? Math.round(sw.right) : null, clickable: !visible || !!hit?.closest('button') }
          })
          return { rows: out.length, whole: out.every((o) => o.whole), lined: new Set(out.map((o) => o.switchRight)).size === 1, clickable: out.every((o) => o.clickable), out }
        })
      const fits = async () => { const f = await rowsFit(); return f.rows > 2 && f.whole && f.lined && f.clickable }
      await branches.locator(`[data-branch="${long}"]`).scrollIntoViewIfNeeded()
      check('with a remote, a long branch tracking it: every row’s time and actions whole, lined up, Switch clickable', !!(await lib.until(fits, HUNG_MS)), JSON.stringify(await rowsFit()))
      await lib.fitWindow(app, page, { width: 900, height: 820 })
      await branches.locator(`[data-branch="${long}"]`).scrollIntoViewIfNeeded()
      check('…at a narrow width too', !!(await lib.until(fits, HUNG_MS)), JSON.stringify(await rowsFit()))
      for (const look of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme: look } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === look, HUNG_MS)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(lib.WORK, `gitremotes-rows-narrow-${look}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
      await lib.fitWindow(app, page, { width: 1500, height: 900 })
      g(alpha, 'branch', '-D', long)
      await page.locator('[data-action="reload-branches"]').click()
      await lib.until(async () => (await branches.locator(`[data-branch="${long}"]`).count()) === 0, HUNG_MS)

      // --- Stop tracking.
      await lib.until(async () => (await featureRow.locator('[data-action="untrack"]').count()) === 1, HUNG_MS)
      await featureRow.locator('[data-action="untrack"]').click()
      const untrack = page.locator('.dialog', { hasText: 'Stop feature/x tracking origin/feature/x?' })
      await lib.until(async () => (await untrack.count()) === 1, HUNG_MS)
      await untrack.getByRole('button', { name: 'Stop tracking', exact: true }).click()
      check('Stop tracking clears what it tracks, and the remote keeps its branch', !!(await lib.until(async () => upstreamOf('feature/x') === '' && (await featureRow.locator('[data-action="untrack"]').count()) === 0, HUNG_MS)) && !!has(origin, 'feature/x'))

      // --- Rename backup to nas: main follows.
      await branches.locator('[data-remote="backup"] [data-action="rename-remote"]').click()
      const rename = page.locator('.dialog', { hasText: 'Rename backup' })
      await lib.until(async () => (await rename.count()) === 1, HUNG_MS)
      await rename.locator('input').fill('origin')
      await rename.getByRole('button', { name: 'Rename', exact: true }).click()
      check('Rename refuses a name another remote has, and stays open', !!(await lib.until(async () => /There is a remote called origin already/.test(await text(rename)), HUNG_MS)) && (await rename.count()) === 1 && g(alpha, 'remote').includes('backup'), await text(rename))
      await rename.locator('input').fill('nas')
      await rename.getByRole('button', { name: 'Rename', exact: true }).click()
      check('…renames it, and main tracks it by its new name', !!(await lib.until(async () => (await branches.locator('[data-remote="nas"]').count()) === 1, HUNG_MS)) && upstreamOf('main') === 'nas/main' && g(alpha, 'remote').split(/\r?\n/).sort().join(',') === 'nas,origin')

      // --- Remove nas: its tracking branch named, then cleared; the remote's own branches untouched.
      await branches.locator('[data-remote="nas"] [data-action="remove-remote"]').click()
      const remove = page.locator('.dialog', { hasText: 'Remove the remote nas?' })
      await lib.until(async () => (await remove.count()) === 1, HUNG_MS)
      check('Remove names the branches that stop tracking it, and that nothing on the remote changes', /this branch stops tracking it/.test(await text(remove)) && JSON.stringify(await remove.locator('.dialog-list li').allInnerTexts()) === JSON.stringify(['main']) && /Nothing on nas itself changes/.test(await text(remove)), await text(remove))
      await shot(page, '3-remove-dark')
      await theme('light')
      await shot(page, '3-remove-light')
      await theme('dark')
      await remove.getByRole('button', { name: 'Remove', exact: true }).click()
      check('…removes it: main tracks nothing, and the remote keeps its branches', !!(await lib.until(async () => (await branches.locator('[data-remote="nas"]').count()) === 0, HUNG_MS)) && upstreamOf('main') === '' && g(alpha, 'remote') === 'origin' && !!has(backup, 'main') && !!has(backup, 'feature/x'))
      await shot(page, '4-after-dark')
    } finally {
      await app.close()
    }
  }

  // Push to… in German, looked at only.
  {
    const { app, page, inv } = await lib.launch({ userData, env: { ...env, CW_LANG: 'de' }, viewport: { width: 1500, height: 900 } })
    try {
      await lib.openWorkspace(inv, page, ws)
      g(alpha, 'remote', 'add', 'backup', backup)
      await page.getByText('alpha', { exact: true }).first().click()
      await page.locator('.statusbar [data-git-status]').click()
      const pushToButton = page.locator('[data-git-branches] [data-action="push-to"]')
      await lib.until(async () => (await pushToButton.count()) === 1 && !(await pushToButton.isDisabled()), HUNG_MS)
      await pushToButton.click()
      await lib.until(async () => (await page.locator('.dialog #git-form-scope').count()) === 1, HUNG_MS)
      await shot(page, '5-push-to-de')
    } finally {
      await app.close()
    }
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
