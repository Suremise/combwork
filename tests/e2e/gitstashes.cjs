// Stashes (HI-3472) in Version Control → Changes, driven in the window: a project with two stashes, one made as
// Combwork's Set Aside names its own (with an untracked file) and one plain. The section lists both, Combwork's by its
// card; Show lists a stash's files, untracked ones included, and a click shows one's diff in place of the folder's;
// Apply puts a stash in and keeps it, and a second Apply is refused while the folder has changes to its file; Pop puts
// Combwork's in and drops it; a Pop that conflicts keeps its stash, the file left with git's markers, said in a warning,
// and (HI-3518) shown in Changes' panel as left in conflict, from that stash, where Use the stash's settles it;
// Drop (asked first) deletes the row clicked (HI-3527: the bottom of two rows of one commit, then the top), the list
// showing the rows git has, and the last one dropped, the section goes (HI-3532: git's list read meanwhile can say
// "bad revision 'refs/stash'", read again). Screenshots of the section, Show's diff and the Drop
// question in both themes. Git's global config the suite's own. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'gitstashes-profile')
const ws = path.join(lib.WORK, 'gitstashes-ws')
const claudeHome = path.join(lib.WORK, 'gitstashes-claude-home')
const globalConfig = path.join(lib.WORK, 'gitstashes-gitconfig')
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
  // git's errors in what it throws (e.stderr), not on the suite's console.
  const g = (...a) => execFileSync('git', a, { cwd: alpha, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const read = (f) => (fs.existsSync(path.join(alpha, f)) ? fs.readFileSync(path.join(alpha, f), 'utf8') : null)
  fs.mkdirSync(alpha, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', alpha], { env: gitEnv })
  fs.writeFileSync(path.join(alpha, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(alpha, 'b.txt'), 'b\n')
  g('add', '-A')
  g('commit', '-qm', 'first')
  // Combwork's (Set Aside's name and mark), with an untracked file; then a plain one.
  fs.writeFileSync(path.join(alpha, 'a.txt'), 'a set aside\n')
  fs.writeFileSync(path.join(alpha, 'new.txt'), 'new\n')
  g('stash', 'push', '--include-untracked', '-q', '-m', 'Combwork: set aside before merging HI-12 [cw:abc123]')
  fs.writeFileSync(path.join(alpha, 'b.txt'), 'b stashed\n')
  g('stash', 'push', '-q', '-m', 'my own work')
  // The stash list as git has it now; null while git can't say. HI-3532: while the last stash is dropped git empties its
  // reflog, then deletes refs/stash, and a list read between the two fails with "bad revision 'refs/stash'". A poll reads
  // again; anything else git says is the run's error.
  const stashList = (format) => {
    try {
      return g('stash', 'list', `--format=${format}`).split(/\r?\n/).filter(Boolean)
    } catch (e) {
      if (/bad revision 'refs\/stash'/.test(String(e.stderr ?? ''))) return null
      throw e
    }
  }
  const stashes = () => stashList('%H')
  const [plain, ours] = stashes()
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, CW_API_PORT: lib.port(47604), GIT_CONFIG_GLOBAL: globalConfig }

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
        await loc.screenshot({ path: path.join(lib.WORK, `gitstashes-${name}-${t}.png`) })
      }
      await theme('dark')
    }
    const toasts = () => page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')).catch(() => '')
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await lib.vcSection(page, 'changes')
    const section = page.locator('.stash-section')
    const row = (c) => section.locator(`[data-stash="${c}"]`)
    const ask = (title) => page.locator('.dialog', { hasText: title })

    // --- The list.
    check('the section shows, counting both stashes', !!(await lib.until(async () => (await section.getAttribute('data-stashes').catch(() => null)) === '2', HUNG_MS)), await text(section))
    await section.locator('[data-action="stashes-toggle"]').click()
    await lib.until(async () => (await section.locator('[data-stash]').count()) === 2, HUNG_MS)
    const first = await section.locator('[data-stash]').first().getAttribute('data-stash')
    check('newest first: the plain one, by its message, on main', first === plain && /my own work/.test(await text(row(plain))) && /on main/.test(await text(row(plain))) && /1 file\b/.test(await text(row(plain))), await text(section))
    check("Combwork's says why and links its card; it holds 2 files, its untracked one counted", (await row(ours).getAttribute('data-combwork')) === 'merging' && /Set aside by Combwork before merging HI-12/.test(await text(row(ours))) && /2 files/.test(await text(row(ours))), await text(row(ours)))
    await shoot(section, '1-list')

    // --- Show: its files, a click showing one's diff in place of the folder's.
    await row(ours).locator('[data-action="stash-show"]').click()
    const files = row(ours).locator('[data-stash-file]')
    check('Show lists its changed file, then its untracked one', !!(await lib.until(async () => (await files.count()) === 2, HUNG_MS)) && (await files.nth(0).getAttribute('data-stash-file')) === 'a.txt' && (await files.nth(1).getAttribute('data-stash-file')) === 'new.txt' && /untracked/.test(await text(files.nth(1))), await text(row(ours)))
    await files.nth(0).click()
    const diff = page.locator('[data-stash-diff="a.txt"]')
    check("…a click shows the file's diff, named as the stash's", !!(await lib.until(async () => (await diff.count()) === 1, HUNG_MS)) && /in the stash/.test(await text(diff)), await text(diff))
    check('…its diff drawn', !!(await lib.until(async () => (await page.locator('.split-main .editor-host .monaco-diff-editor').count()) === 1 && (await page.locator('.split-main .editor-host .empty-state').count()) === 0, HUNG_MS)))
    await shoot(page.locator('.split-main'), '2-show')
    await page.locator('[data-action="stash-diff-close"]').click()
    check('…its close button goes back to the folder', !!(await lib.until(async () => (await diff.count()) === 0, HUNG_MS)))

    // --- Apply: in, the stash kept; again, refused (the folder now has changes to its file).
    await row(plain).locator('[data-action="stash-apply"]').click()
    let q = ask('Apply the stash to the project folder?')
    await q.waitFor({ timeout: HUNG_MS })
    check('Apply asks first, naming the stash', /my own work/.test(await text(q)) && /The stash is kept/.test(await text(q)), await text(q))
    await q.getByRole('button', { name: 'Apply', exact: true }).click()
    check('…applied: b.txt has its change, the stash is still listed', !!(await lib.until(async () => read('b.txt') === 'b stashed\n', HUNG_MS)) && stashes()?.length === 2, `${read('b.txt')} | ${stashes()?.length}`)
    await row(plain).locator('[data-action="stash-apply"]').click()
    q = ask('Apply the stash to the project folder?')
    await q.waitFor({ timeout: HUNG_MS })
    await q.getByRole('button', { name: 'Apply', exact: true }).click()
    check('a second Apply is refused: b.txt has uncommitted changes the stash holds', !!(await lib.until(async () => /b\.txt has uncommitted changes/.test(await toasts()), HUNG_MS)), await toasts())
    g('checkout', '-q', '--', 'b.txt')

    // --- Pop of Combwork's: in, dropped.
    await row(ours).locator('[data-action="stash-pop"]').click()
    q = ask('Pop the stash into the project folder?')
    await q.waitFor({ timeout: HUNG_MS })
    await q.getByRole('button', { name: 'Pop', exact: true }).click()
    check('Pop puts its changes in, its untracked file too, and drops it', !!(await lib.until(async () => read('a.txt') === 'a set aside\n' && read('new.txt') === 'new\n' && stashes()?.length === 1, HUNG_MS)) && !!(await lib.until(async () => (await section.locator('[data-stash]').count()) === 1, HUNG_MS)), `${read('a.txt')} | ${stashes()?.length}`)
    g('add', '-A')
    g('commit', '-qm', 'took it')

    // --- A Pop that conflicts: the stash kept, the file left with git's markers, a warning.
    fs.writeFileSync(path.join(alpha, 'b.txt'), 'b moved on\n')
    g('commit', '-qam', 'moved on')
    await row(plain).locator('[data-action="stash-pop"]').click()
    q = ask('Pop the stash into the project folder?')
    await q.waitFor({ timeout: HUNG_MS })
    await q.getByRole('button', { name: 'Pop', exact: true }).click()
    check('a Pop that conflicts keeps the stash and says which file', !!(await lib.until(async () => /1 file is in conflict in the project folder/.test(await toasts()), HUNG_MS)) && stashes()?.length === 1 && /<<<<<<</.test(read('b.txt') ?? ''), `${await toasts()} | ${stashes()?.length}`)
    // HI-3518: Changes' panel shows the file left in conflict, with no operation under way: where it came from, the
    // stash's side named on its button, no step. Use the stash's settles it, and with nothing left the panel goes.
    const left = page.locator('.operation-panel[data-operation="conflicts"]')
    // What it shows waited for as a whole, not its first row alone (HI-3528: the row and its stash come in one read now,
    // but a check of text read once the row appears would pass or fail by when the panel read).
    check("HI-3518: the panel shows the file left in conflict, from the stash, with no step", !!(await lib.until(async () => (await left.locator('[data-conflict="b.txt"]').count()) === 1 && /Files left in conflict in the project folder/.test(await text(left)) && (await text(left)).includes('From applying the stash “my own work”'), HUNG_MS)) && (await left.locator('[data-step]').count()) === 0 && (await left.locator('[data-pick="theirs"]').innerText()).includes("Use the stash's"), await text(left).catch(() => ''))
    // Its notifications dismissed by their own close buttons, so the screenshot shows the panel under them.
    check('…its notifications dismissed for the screenshot', !!(await lib.until(async () => {
      const close = page.locator('.popup-close')
      if ((await close.count()) === 0) return true
      await close.first().click().catch(() => undefined)
      return false
    }, HUNG_MS)))
    await shoot(left, '4-left-conflicts')
    await left.locator('[data-conflict="b.txt"] [data-pick="theirs"]').click()
    check("…Use the stash's takes its side and settles the file; nothing left, the panel goes", !!(await lib.until(async () => (await left.count()) === 0, HUNG_MS)) && read('b.txt') === 'b stashed\n' && g('diff', '--name-only', '--diff-filter=U').trim() === '', `${read('b.txt')} | ${await text(left).catch(() => '')}`)

    // --- Drop, asked first. HI-3527: of the row clicked, though another row lists the same commit (`git stash store`
    // of it, under another stash: git lists a commit again only under another top).
    const between = g('stash', 'create').trim()
    g('stash', 'store', '-m', 'between', between)
    g('stash', 'store', '-m', 'relisted', plain)
    const messages = () => stashList('%gs')?.map((m) => m.replace(/^On [^:]+: /, ''))
    // A write in the folder: Changes reads again, and the list with it.
    fs.writeFileSync(path.join(alpha, 'poke.txt'), 'poke\n')
    const at = (i) => section.locator(`[data-stash-index="${i}"]`)
    const shownRows = async () => Promise.all((await section.locator('[data-stash]').all()).map(async (r) => `${await r.getAttribute('data-stash-index')}:${await r.getAttribute('data-stash')}`))
    check('HI-3527: the list shows both rows of the commit, and the one between', !!(await lib.until(async () => (await shownRows()).join(' ') === `0:${plain} 1:${between} 2:${plain}`, HUNG_MS)), (await shownRows()).join(' '))
    await at(2).locator('[data-action="stash-drop"]').click()
    q = ask('Drop the stash “my own work”?')
    await q.waitFor({ timeout: HUNG_MS })
    check('Drop asks first, saying its files and its commit', /the 1 file it holds/.test(await text(q)) && (await text(q)).includes(plain.slice(0, 10)), await text(q))
    await shoot(q, '3-drop')
    await q.getByRole('button', { name: 'Drop', exact: true }).click()
    check('…dropped: the row clicked, the commit said; the other row of its commit kept', !!(await lib.until(async () => messages()?.join(' | ') === 'relisted | between' && (await toasts()).includes(plain), HUNG_MS)),`${messages()?.join(' | ')} | ${await toasts()}`)
    check('…the list shows the rows git has, no more', !!(await lib.until(async () => (await shownRows()).join(' ') === `0:${plain} 1:${between}` && /relisted/.test(await text(at(0))), HUNG_MS)), (await shownRows()).join(' '))
    await at(0).locator('[data-action="stash-drop"]').click()
    q = ask('Drop the stash “relisted”?')
    await q.waitFor({ timeout: HUNG_MS })
    await q.getByRole('button', { name: 'Drop', exact: true }).click()
    check('…the top row by its own Drop: the one between is left, listed alone', !!(await lib.until(async () => messages()?.join(' | ') === 'between' && (await shownRows()).join(' ') === `0:${between}`, HUNG_MS)), `${messages()?.join(' | ')} | ${(await shownRows()).join(' ')}`)
    // The last one dropped: the section goes. HI-3532: the poll reads git's list while the window's drop of the last stash
    // runs, when git can briefly answer "bad revision 'refs/stash'" (stashList: read again).
    await at(0).locator('[data-action="stash-drop"]').click()
    q = ask('Drop the stash “between”?')
    await q.waitFor({ timeout: HUNG_MS })
    await q.getByRole('button', { name: 'Drop', exact: true }).click()
    check('…the last dropped: no stash left, the section gone, the commit said', !!(await lib.until(async () => stashes()?.length === 0 && (await section.count()) === 0 && (await toasts()).includes(between), HUNG_MS)),`${stashes()?.length} | ${await toasts()}`)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
