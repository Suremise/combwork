// Branches by state and Clean Up Merged Branches (#1642, Darren's 20 branches on rc.1 in small): a project on main
// (its target: no workflow target set) with a branch checked out in a worktree (a slot's), three branches merged into
// main and unused, one with two commits of its own, all pushed to a second remote, nas, plus one merged branch only nas
// has. The list stays a list (Darren's decision) under three headings: In use, Merged into main, Not merged into main,
// the last saying how many commits; the remote branches grouped the same way. Clean Up offers exactly the merged unused
// ones, ticked, never main or the slot's branch, and nas's apart under a warning, none ticked; untick one, tick one on
// nas, Delete Ticked: those go, the rest stay. Round 2: a third remote, other, unreachable by then, fails after the local
// branches and nas's went; a tick changed, Try Again deletes only other's (nothing done is asked again). The unmerged
// branch's 🗑 lists its two commits first, then deletes it.
// Remotes are local bare repositories in the suite's folder (never a real remote), git's global config the suite's own.
// Screenshots of the list and the dialog in both themes. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'gitcleanup-profile')
const ws = path.join(lib.WORK, 'gitcleanup-ws')
const nas = path.join(lib.WORK, 'gitcleanup-nas.git')
const otherRepo = path.join(lib.WORK, 'gitcleanup-other.git')
const missing = path.join(lib.WORK, 'gitcleanup-missing.git')
const slot = path.join(lib.WORK, 'gitcleanup-slot-a')
const claudeHome = path.join(lib.WORK, 'gitcleanup-claude-home')
const globalConfig = path.join(lib.WORK, 'gitcleanup-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `gitcleanup-${name}.png`) })

;(async () => {
  for (const d of [userData, ws, nas, otherRepo, missing, slot, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = 1+test@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
  const commit = (file) => {
    fs.writeFileSync(path.join(alpha, file), `${file}\n`)
    g(alpha, 'add', '-A')
    g(alpha, 'commit', '-qm', `add ${file}`)
  }
  const heads = (repo) => g(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort()
  fs.mkdirSync(alpha, { recursive: true })
  for (const r of [nas, otherRepo]) execFileSync('git', ['init', '-q', '--bare', '-b', 'main', r], { env: gitEnv })
  g(ws, 'init', '-q', '-b', 'main', alpha)
  commit('a.txt')
  for (const b of ['hive/hb1', 'hive/hb2', 'backup/hb5', 'hive/slot-line']) g(alpha, 'branch', b)
  g(alpha, 'checkout', '-q', '-b', 'spike/i18n')
  commit('spike-1.txt')
  commit('spike-2.txt')
  g(alpha, 'checkout', '-q', 'main')
  commit('b.txt')
  g(alpha, 'worktree', 'add', '-q', slot, 'hive/slot-line')
  g(alpha, 'remote', 'add', 'nas', nas)
  g(alpha, 'push', '-q', 'nas', 'main', 'hive/hb1', 'hive/hb2', 'backup/hb5', 'spike/i18n', 'hive/slot-line', 'main:refs/heads/old/only-on-nas')
  g(alpha, 'fetch', '-q', 'nas')
  g(alpha, 'remote', 'add', 'other', otherRepo)
  g(alpha, 'push', '-q', 'other', 'main', 'hive/hb2')
  g(alpha, 'fetch', '-q', 'other')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, HIVE_API_PORT: lib.port(47798), GIT_CONFIG_GLOBAL: globalConfig }

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
    // Each group's branches, in the list's order: the rows after its heading up to the next.
    const groups = () =>
      branches.evaluate((el) => {
        const out = {}
        let at = null
        for (const row of el.querySelectorAll('.git-rows')[0].children) {
          if (row.dataset.branchGroup && !row.hasAttribute('data-remote-group')) at = out[row.dataset.branchGroup] = []
          else if (row.dataset.branch && at) at.push(row.dataset.branch)
        }
        return out
      })

    // --- Three groups, a list as before.
    const grouped = await lib.until(async () => {
      const gr = await groups()
      return gr.inUse && gr.merged && gr.unmerged ? gr : null
    }, HUNG_MS)
    check('In use: main and the slot’s branch', JSON.stringify(grouped?.inUse?.slice().sort()) === JSON.stringify(['hive/slot-line', 'main']), JSON.stringify(grouped))
    check('Merged into main: the three nothing uses', JSON.stringify(grouped?.merged?.slice().sort()) === JSON.stringify(['backup/hb5', 'hive/hb1', 'hive/hb2']), JSON.stringify(grouped))
    check('Not merged into main: the spike, with its two commits', JSON.stringify(grouped?.unmerged) === JSON.stringify(['spike/i18n']) && /2 commits not in main/.test(await text(branches.locator('[data-branch="spike/i18n"]'))), await text(branches.locator('[data-branch="spike/i18n"]')))
    check('the headings name the target and count', /Merged into main\s*3/i.test(await text(branches.locator('[data-branch-group="merged"]').first())), await text(branches.locator('[data-branch-group="merged"]').first()))
    check('no Delete beside a branch in use; one beside each free one', (await branches.locator('[data-branch="main"] [data-action="delete-branch"], [data-branch="hive/slot-line"] [data-action="delete-branch"]').count()) === 0 && (await branches.locator('[data-action="delete-branch"]').count()) === 4)
    await branches.getByRole('button', { name: /Remote branches \(1\)/ }).click()
    const remoteRow = branches.locator('[data-remote-branch="nas/old/only-on-nas"]')
    await lib.until(async () => (await remoteRow.count()) === 1, HUNG_MS)
    check('a remote-only branch grouped too: merged', (await branches.locator('[data-remote-group][data-branch-group="merged"]').count()) === 1)
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await branches.locator('.git-rows').first().screenshot({ path: path.join(lib.WORK, `gitcleanup-1-groups-${t}.png`) })
    }
    await theme('dark')

    // --- Clean Up: exactly the merged unused ones, ticked; nas's apart, none ticked; never main or a slot's branch.
    await branches.locator('[data-action="clean-up-branches"]').click()
    const dialog = page.locator('.dialog', { hasText: 'Clean up merged branches' })
    await lib.until(async () => (await dialog.locator('[data-git-cleanup]').count()) === 1, HUNG_MS)
    const ticks = (kind) => dialog.locator(`[data-cleanup-${kind}]`).evaluateAll((els, k) => els.map((e) => `${e.getAttribute(`data-cleanup-${k}`)}${e.checked ? ':on' : ''}`), kind)
    check('local: the three merged unused branches, ticked', JSON.stringify(await ticks('local')) === JSON.stringify(['backup/hb5:on', 'hive/hb1:on', 'hive/hb2:on']), JSON.stringify(await ticks('local')))
    check('nas and other: their merged branches but main and the slot’s, none ticked', JSON.stringify(await ticks('remote')) === JSON.stringify(['nas/backup/hb5', 'nas/hive/hb1', 'nas/hive/hb2', 'nas/old/only-on-nas', 'other/hive/hb2']), JSON.stringify(await ticks('remote')))
    check('…under a warning that it deletes on the remote', /deletes them on the remote, for everyone/.test(await text(dialog.locator('[data-git-cleanup-remote-warning]'))))
    check('…each whose local branch is ticked says so', (await dialog.locator('li', { hasText: 'nas/hive/hb1' }).innerText()).includes('its local branch is ticked above') && !(await dialog.locator('li', { hasText: 'nas/old/only-on-nas' }).innerText()).includes('ticked above'))
    await dialog.locator('[data-cleanup-local="backup/hb5"]').uncheck()
    await dialog.locator('[data-cleanup-remote="nas/hive/hb1"]').check()
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await dialog.screenshot({ path: path.join(lib.WORK, `gitcleanup-2-dialog-${t}.png`) })
    }
    await theme('dark')
    // other can't be reached by the time it is asked (round 2): the local branches and nas's go first, then it fails.
    await dialog.locator('[data-cleanup-remote="other/hive/hb2"]').check()
    g(alpha, 'remote', 'set-url', 'other', missing)
    await dialog.getByRole('button', { name: 'Delete Ticked', exact: true }).click()
    const partly = await lib.until(async () => ((await dialog.locator('.dialog-error').count()) === 1 && !heads(alpha).includes('hive/hb1') && !heads(nas).includes('hive/hb1') ? true : null), HUNG_MS)
    check('Delete Ticked: the local branches and nas’s go, other’s fails in the dialog', !!partly && JSON.stringify(heads(alpha)) === JSON.stringify(['backup/hb5', 'hive/slot-line', 'main', 'spike/i18n']) && JSON.stringify(heads(nas)) === JSON.stringify(['backup/hb5', 'hive/hb2', 'hive/slot-line', 'main', 'old/only-on-nas', 'spike/i18n']) && heads(otherRepo).includes('hive/hb2'), JSON.stringify({ alpha: heads(alpha), nas: heads(nas), error: await text(dialog.locator('.dialog-error')) }))
    // A tick changed after the failure, other reachable again: Try Again asks only for other's (nothing deleted already).
    g(alpha, 'remote', 'set-url', 'other', otherRepo)
    await dialog.locator('[data-cleanup-local="backup/hb5"]').check()
    await dialog.locator('[data-cleanup-local="backup/hb5"]').uncheck()
    await dialog.getByRole('button', { name: 'Try Again', exact: true }).click()
    const retried = await lib.until(async () => ((await dialog.count()) === 0 && !heads(otherRepo).includes('hive/hb2') ? true : null), HUNG_MS)
    check('Try Again: only other’s goes, nothing done is asked again', !!retried && JSON.stringify(heads(otherRepo)) === JSON.stringify(['main']) && heads(alpha).includes('backup/hb5'), JSON.stringify({ other: heads(otherRepo), alpha: heads(alpha), error: await text(dialog.locator('.dialog-error')) }))
    check('…and the list follows', !!(await lib.until(async () => (await branches.locator('[data-branch="hive/hb1"]').count()) === 0 && (await branches.locator('[data-branch="backup/hb5"]').count()) === 1, HUNG_MS)))

    // --- An unmerged branch alone: its commits listed first, then deleted.
    await branches.locator('[data-branch="spike/i18n"] [data-action="delete-branch"]').click()
    const one = page.locator('.dialog', { hasText: 'Delete spike/i18n and the 2 commits only it has?' })
    await lib.until(async () => (await one.count()) === 1, HUNG_MS)
    const listed = await one.locator('.dialog-list li').allInnerTexts()
    check('its two commits listed, newest first', listed.length === 2 && /add spike-2\.txt/.test(listed[0]) && /add spike-1\.txt/.test(listed[1]), JSON.stringify(listed))
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.mouse.move(5, 5)
      await one.screenshot({ path: path.join(lib.WORK, `gitcleanup-3-unmerged-${t}.png`) })
    }
    await theme('dark')
    await one.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('…then deleted', !!(await lib.until(async () => (!heads(alpha).includes('spike/i18n') && (await branches.locator('[data-branch="spike/i18n"]').count()) === 0 ? true : null), HUNG_MS)), JSON.stringify(heads(alpha)))
    check('the slot’s branch and its worktree untouched', heads(alpha).includes('hive/slot-line') && fs.existsSync(path.join(slot, 'a.txt')))
    await shot(page, '4-after')
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
