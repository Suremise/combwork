// Moves (HI-3469) in Version Control → History, driven in the window: a project whose main has commits, a reset and a
// move made as the merge queue makes one (update-ref with no message, its commit carrying a Combwork-Card trailer), and
// a branch checked out nowhere. The Commits | Moves switch shows main's moves in plain words, the queue's as Combwork's
// merge of its card; Restore to here… asks first, listing the commits it drops, and moves main back with the folder's
// unrelated uncommitted file kept; the restore is a move of its own, and Restore to here… on the one below undoes it; a
// file with uncommitted changes the move would change refuses it, named in the dialog; a branch checked out nowhere
// moves alone. Screenshots of the list and both dialogs in both themes. Git's global config the suite's own. Dev build,
// throwaway profile and workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'gitmoves-profile')
const ws = path.join(lib.WORK, 'gitmoves-ws')
const claudeHome = path.join(lib.WORK, 'gitmoves-claude-home')
const globalConfig = path.join(lib.WORK, 'gitmoves-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = 1+test@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\tlogAllRefUpdates = true\n')
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
  const first = g('rev-parse', 'HEAD')
  g('branch', 'side')
  write('a.txt', 'a two\n')
  g('commit', '-qam', 'second')
  write('a.txt', 'a oops\n')
  g('commit', '-qam', 'oops')
  g('reset', '-q', '--hard', 'HEAD~1')
  const second = g('rev-parse', 'HEAD')
  // The merge queue's move: a commit on another line with the card's trailer, main (not checked out meanwhile) moved to
  // it with no message, as the queue's compare-and-swap does.
  g('switch', '-q', '-c', 'work')
  write('c.txt', 'c\n')
  g('add', '-A')
  g('commit', '-qm', 'HI-12: a card', '--trailer', 'Combwork-Card: HI-12')
  const merged = g('rev-parse', 'HEAD')
  g('update-ref', 'refs/heads/main', merged, second)
  g('switch', '-q', 'main')
  g('branch', '-D', 'work')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, CW_API_PORT: lib.port(47605), GIT_CONFIG_GLOBAL: globalConfig }

  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1300, height: 900 } })
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
        await loc.screenshot({ path: path.join(lib.WORK, `gitmoves-${name}-${t}.png`) })
      }
      await theme('dark')
    }
    const toasts = () => page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')).catch(() => '')
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections button', { hasText: 'History' }).click()
    await page.locator('[data-history-view="moves"]').click()
    const moves = page.locator('[data-git-moves]')
    const rows = moves.locator('[data-move]')
    const kinds = async () => (await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-move-kind')))).join(',')
    const head = (ref = 'main') => g('rev-parse', ref)
    const ask = (title) => page.locator('.dialog', { hasText: title })

    // --- The list.
    check("Moves shows main's moves, newest first, the queue's as Combwork's merge", !!(await lib.until(async () => (await moves.getAttribute('data-moves-branch')) === 'main' && (await kinds()).startsWith('combworkMerge,reset,commit,commit'), HUNG_MS)), await kinds())
    const top = rows.first()
    check('…in plain words, its card a link', /Combwork merged HI-12/.test(await text(top)) && (await top.locator('[data-action="move-card"]').count()) === 1 && /HI-12: a card/.test(await text(top)) && (await top.locator('[data-action="move-restore"]').count()) === 0, await text(top))
    check('…a reset said as one, with Restore to here…', /Reset to HEAD~1/.test(await text(rows.nth(1))) && (await rows.nth(1).locator('[data-action="move-restore"]').count()) === 1, await text(rows.nth(1)))
    await shoot(moves, '1-list')

    // --- Restore main to "second" (the reset's move): asked first, the dropped commit listed; the unrelated file kept.
    write('b.txt', 'b mine\n')
    await rows.nth(1).locator('[data-action="move-restore"]').click()
    let q = ask('Restore main to')
    await q.waitFor({ timeout: HUNG_MS })
    check('Restore asks first, naming the commit it drops and that uncommitted changes stay', /The commit it drops/.test(await text(q)) && /HI-12: a card/.test(await text(q)) && /uncommitted changes stay/.test(await text(q)), await text(q))
    await shoot(q, '2-restore')
    await q.getByRole('button', { name: 'Restore', exact: true }).click()
    check('…main is back at that commit, c.txt gone, b.txt as it was left', !!(await lib.until(async () => head() === second && read('c.txt') === null, HUNG_MS)) && read('b.txt') === 'b mine\n', `${head()} | ${read('b.txt')}`)
    check('…the notice names the commit it was at', !!(await lib.until(async () => (await toasts()).includes(merged), HUNG_MS)), await toasts())
    check('…and the restore is a move of its own, at the top', !!(await lib.until(async () => (await kinds()).startsWith('restored,combworkMerge'), HUNG_MS)), await kinds())

    // --- Undone: Restore to here… on the move below it.
    await rows.nth(1).locator('[data-action="move-restore"]').click()
    q = ask('Restore main to')
    await q.waitFor({ timeout: HUNG_MS })
    check('…undoing it brings the commit back', /The commit it brings back/.test(await text(q)), await text(q))
    await q.getByRole('button', { name: 'Restore', exact: true }).click()
    check('…main is at the merge again, c.txt back', !!(await lib.until(async () => head() === merged && read('c.txt') === 'c\n', HUNG_MS)))

    // --- An uncommitted file the move would change refuses it, named.
    g('checkout', '-q', '--', 'b.txt')
    write('a.txt', 'a mine\n')
    await lib.until(async () => (await kinds()).startsWith('restored,restored'), HUNG_MS)
    const toFirst = moves.locator(`[data-move]:has(code.git-hash:text-is("${first.slice(0, 7)}"))`).first()
    await toFirst.locator('[data-action="move-restore"]').click()
    q = ask("main can't be restored now")
    await q.waitFor({ timeout: HUNG_MS })
    check('a file with uncommitted changes the move would change refuses it, named', /An uncommitted file would change/.test(await text(q)) && /a\.txt/.test(await text(q)) && (await q.getByRole('button', { name: 'Restore', exact: true }).count()) === 0, await text(q))
    await shoot(q, '3-refused')
    await q.getByRole('button', { name: 'OK', exact: true }).click()
    check('…nothing changed', head() === merged && read('a.txt') === 'a mine\n')
    g('checkout', '-q', '--', 'a.txt')

    // --- A branch checked out nowhere moves alone.
    g('switch', '-q', 'side')
    write('d.txt', 'd\n')
    g('add', '-A')
    g('commit', '-qm', 'on side')
    g('switch', '-q', 'main')
    await page.locator('[data-moves-picker]').selectOption('side')
    check('the picker shows another branch', !!(await lib.until(async () => (await moves.getAttribute('data-moves-branch')) === 'side' && (await rows.count()) >= 2, HUNG_MS)), await kinds())
    await rows.nth(1).locator('[data-action="move-restore"]').click()
    q = ask('Restore side to')
    await q.waitFor({ timeout: HUNG_MS })
    check("…it isn't checked out: only the branch moves", /isn't checked out in any folder/.test(await text(q)), await text(q))
    await q.getByRole('button', { name: 'Restore', exact: true }).click()
    check('…side is back at the first commit, the folder untouched', !!(await lib.until(async () => head('side') === first, HUNG_MS)) && head() === merged && read('c.txt') === 'c\n', head('side'))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
