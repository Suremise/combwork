// History's Commit dialog (HI-3471), driven in the window: a project whose main has a commit naming a card in its
// subject, and a branch side with two commits, one that conflicts with main. A click on a commit in History opens its
// dialog: the hash, message, files and a file's diff; Revert… asks first and makes a commit undoing it; uncommitted
// changes to a tracked file grey Revert… out, saying why; Cherry-pick… of side's commit (History's picker on side)
// copies it onto main, and one that conflicts leaves git mid-pick, said in a notice, for Changes' panel; Branch from
// here… opens New branch… starting at the commit; Tag here… tags it. A move in Moves opens the same dialog.
// Screenshots of the dialog and the Revert question in both themes. Git's global config the suite's own. Dev build,
// throwaway profile and workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'gitcommit-profile')
const ws = path.join(lib.WORK, 'gitcommit-ws')
const claudeHome = path.join(lib.WORK, 'gitcommit-claude-home')
const globalConfig = path.join(lib.WORK, 'gitcommit-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = 1+test@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (...a) => execFileSync('git', a, { cwd: alpha, env: gitEnv, encoding: 'utf8' }).trim()
  const read = (f) => (fs.existsSync(path.join(alpha, f)) ? fs.readFileSync(path.join(alpha, f), 'utf8') : null)
  const write = (f, t) => fs.writeFileSync(path.join(alpha, f), t)
  fs.mkdirSync(alpha, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', alpha], { env: gitEnv })
  write('a.txt', 'a\n')
  write('b.txt', 'b\n')
  g('add', '-A')
  g('commit', '-qm', 'first')
  g('switch', '-q', '-c', 'side')
  write('s.txt', 's\n')
  g('add', '-A')
  g('commit', '-qm', 'side file')
  const sideFile = g('rev-parse', 'HEAD')
  write('b.txt', 'b from side\n')
  g('commit', '-qam', 'side edits b')
  const sideB = g('rev-parse', 'HEAD')
  g('switch', '-q', 'main')
  write('a.txt', 'a two\n')
  g('commit', '-qm', 'AL-5: change a', '-q', '-a')
  const two = g('rev-parse', 'HEAD')
  write('b.txt', 'b from main\n')
  g('commit', '-qam', 'main edits b')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, CW_API_PORT: lib.port(47606), GIT_CONFIG_GLOBAL: globalConfig }

  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.openWorkspace(inv, page, ws)
    const text = (loc) => loc.innerText().catch(() => '')
    const theme = async (t) => {
      await inv('settings:update', { appearance: { theme: t } })
      await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
    }
    const shoot = async (loc, name) => {
      for (const t of ['dark', 'light']) {
        await theme(t)
        await page.mouse.move(5, 5)
        await loc.screenshot({ path: path.join(lib.WORK, `gitcommit-${name}-${t}.png`) })
      }
      await theme('dark')
    }
    const toasts = () => page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')).catch(() => '')
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections button', { hasText: 'History' }).click()
    const history = page.locator('[data-git-history]')
    const row = (c) => history.locator(`[data-commit="${c.slice(0, 7)}"]`)
    const dialog = page.locator('[data-commit-dialog]')
    // A question (or form) over the Commit dialog, never the Commit dialog itself.
    const ask = (title) => page.locator('.dialog:not(:has([data-commit-dialog]))', { hasText: title })
    const closeDialog = () => page.locator('.dialog', { has: dialog }).getByRole('button', { name: 'Close', exact: true }).click()
    const head = (ref = 'HEAD') => g('rev-parse', ref)

    // --- The dialog: its hash, message, files and a file's diff.
    await lib.until(async () => (await row(two).count()) === 1, HUNG_MS)
    await row(two).click()
    check('a click on a commit opens its dialog', !!(await lib.until(async () => (await dialog.getAttribute('data-commit-dialog').catch(() => null)) === two, HUNG_MS)))
    check('…its subject, hash and file', /AL-5: change a/.test(await text(dialog)) && (await text(dialog.locator('[data-commit-hash]'))) === two && (await dialog.locator('[data-commit-file="a.txt"]').count()) === 1, await text(dialog))
    // Drawn with room: an editor squashed to nothing in its pane shows no lines.
    check("…the file's diff drawn, its lines shown", !!(await lib.until(async () => (await dialog.locator('.monaco-diff-editor').count()) === 1 && ((await dialog.locator('.monaco-diff-editor').boundingBox())?.height ?? 0) > 150 && (await dialog.locator('.monaco-diff-editor .view-line').count()) > 0, HUNG_MS)))
    check('…Revert… offered, Cherry-pick… greyed out (main has it), saying why', (await dialog.locator('[data-action="commit-revert"]').isEnabled()) && !(await dialog.locator('[data-action="commit-cherryPick"]').isEnabled()))
    await shoot(page.locator('.dialog', { has: dialog }), '1-dialog')

    // --- Revert…: asked first, a new commit undoes it.
    await dialog.locator('[data-action="commit-revert"]').click()
    let q = ask('Revert ')
    await q.waitFor({ timeout: HUNG_MS })
    check('Revert… asks first, naming the branch and the commit', (await text(q)).includes(`Revert ${two.slice(0, 7)} on main?`) && /change a/.test(await text(q)), await text(q))
    await shoot(q, '2-revert')
    await q.getByRole('button', { name: 'Revert', exact: true }).click()
    check('…a new commit undoes it', !!(await lib.until(async () => read('a.txt') === 'a\n' && g('log', '-1', '--format=%s').startsWith('Revert "AL-5: change a"'), HUNG_MS)), g('log', '-1', '--format=%s'))
    check('…said in a notice', !!(await lib.until(async () => (await toasts()).includes(`Reverted ${two.slice(0, 7)} on main`), HUNG_MS)), await toasts())
    await closeDialog()

    // --- Uncommitted changes to a tracked file grey Revert… out, saying why.
    write('a.txt', 'mine\n')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await lib.until(async () => (await row(two).count()) === 1, HUNG_MS)
    await row(two).click()
    await lib.until(async () => (await dialog.locator('[data-action="commit-revert"]').count()) === 1, HUNG_MS)
    check('uncommitted changes grey Revert… out', !!(await lib.until(async () => !(await dialog.locator('[data-action="commit-revert"]').isEnabled()), HUNG_MS)))
    await closeDialog()
    g('checkout', '-q', '--', 'a.txt')

    // --- Cherry-pick… of side's commit onto main (History on side), then one that conflicts.
    await history.locator('[data-history-branch]').selectOption('refs/heads/side')
    await lib.until(async () => (await row(sideFile).count()) === 1, HUNG_MS)
    await row(sideFile).click()
    await lib.until(async () => (await dialog.getAttribute('data-commit-dialog').catch(() => null)) === sideFile, HUNG_MS)
    check("side's commit: Revert… greyed out (main hasn't it), Cherry-pick… offered", !!(await lib.until(async () => (await dialog.locator('[data-action="commit-cherryPick"]').isEnabled()) && !(await dialog.locator('[data-action="commit-revert"]').isEnabled()), HUNG_MS)))
    await dialog.locator('[data-action="commit-cherryPick"]').click()
    q = ask('Cherry-pick ')
    await q.waitFor({ timeout: HUNG_MS })
    await q.getByRole('button', { name: 'Cherry-pick', exact: true }).click()
    check('…picked onto main', !!(await lib.until(async () => read('s.txt') === 's\n' && g('log', '-1', '--format=%s') === 'side file', HUNG_MS)))
    await closeDialog()
    await lib.until(async () => (await row(sideB).count()) === 1, HUNG_MS)
    await row(sideB).click()
    await lib.until(async () => (await dialog.getAttribute('data-commit-dialog').catch(() => null)) === sideB && (await dialog.locator('[data-action="commit-cherryPick"]').isEnabled()), HUNG_MS)
    await dialog.locator('[data-action="commit-cherryPick"]').click()
    q = ask('Cherry-pick ')
    await q.waitFor({ timeout: HUNG_MS })
    await q.getByRole('button', { name: 'Cherry-pick', exact: true }).click()
    check('a pick that conflicts leaves git mid-pick, said in a notice', !!(await lib.until(async () => /stopped on a conflict in 1 file/.test(await toasts()), HUNG_MS)) && fs.existsSync(path.join(alpha, '.git', 'CHERRY_PICK_HEAD')), await toasts())
    g('cherry-pick', '--abort')
    await closeDialog()

    // --- Branch from here… and Tag here…, at side's first commit.
    await row(sideFile).click()
    await lib.until(async () => (await dialog.getAttribute('data-commit-dialog').catch(() => null)) === sideFile, HUNG_MS)
    await dialog.locator('[data-action="commit-branch"]').click()
    const nb = ask('New branch')
    await nb.waitFor({ timeout: HUNG_MS })
    check('Branch from here… opens New branch… starting at the commit', (await nb.locator('[data-field="start"]').inputValue()) === sideFile)
    await nb.locator('[data-field="name"]').fill('from-here')
    await nb.getByRole('button', { name: 'Create', exact: true }).click()
    check('…the branch is made there, the folder staying on main', !!(await lib.until(async () => { try { return head('refs/heads/from-here') === sideFile } catch { return false } }, HUNG_MS)) && g('symbolic-ref', '--short', 'HEAD') === 'main')
    await row(sideFile).click()
    await lib.until(async () => (await dialog.getAttribute('data-commit-dialog').catch(() => null)) === sideFile, HUNG_MS)
    await dialog.locator('[data-action="commit-tag"]').click()
    const tag = ask(`Tag ${sideFile.slice(0, 7)}`)
    await tag.waitFor({ timeout: HUNG_MS })
    await tag.locator('#git-form-name').fill('v-here')
    await tag.getByRole('button', { name: 'Create tag', exact: true }).click()
    check('Tag here… tags that commit, not the one checked out', !!(await lib.until(async () => { try { return head('v-here^{commit}') === sideFile } catch { return false } }, HUNG_MS)))

    // --- A move in Moves opens the same dialog.
    await history.locator('[data-history-branch]').selectOption('refs/heads/main').catch(() => undefined)
    await page.locator('[data-history-view="moves"]').click()
    const moves = page.locator('[data-git-moves]')
    await lib.until(async () => (await moves.locator('[data-move]').count()) > 0, HUNG_MS)
    await moves.locator('[data-move]').first().locator('[data-action="move-commit"]').click()
    check("a move's commit opens its dialog", !!(await lib.until(async () => (await dialog.getAttribute('data-commit-dialog').catch(() => null)) === head('main'), HUNG_MS)))
    await closeDialog()
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
