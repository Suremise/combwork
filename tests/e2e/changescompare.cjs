// The Changes tab's comparison of two branches (HI-1824). A project whose work goes to 1.0.0 (its workflow target)
// opens Changes on 1.0.0 against main, the picker's first entry: 120 commits 1.0.0 has that main hasn't, and 1 the
// other way; the 254 files 1.0.0 changes since it left main, 200 listed until Show more; a text file's diff, opened
// when it is clicked, and a binary one's notice; each side's commits, 50 a page; Swap compares the other way round.
// Nothing in the repository changes (refs, index, working tree, worktrees), and a name that isn't a branch is refused.
// Screenshots in both themes. The repository is made with the suite's own git; throwaway profile and workspace; quiet;
// no agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'changescompare-profile')
const ws = path.join(lib.WORK, 'changescompare-ws')
const proj = path.join(ws, 'proj')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a]).trim()

/** What the comparison must leave as it was: every ref, the index (its bytes and time), the status, the worktrees. */
function state() {
  const index = path.join(proj, '.git', 'index')
  return JSON.stringify({ refs: git(proj, 'for-each-ref'), index: fs.readFileSync(index).toString('base64'), mtime: fs.statSync(index).mtimeMs, status: git(proj, '--no-optional-locks', 'status', '--porcelain').split('\n').filter((l) => !l.includes('.hive')).join('\n'), worktrees: git(proj, 'worktree', 'list', '--porcelain') })
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  git(ws, 'init', '-q', '-b', 'main', proj)
  fs.writeFileSync(path.join(proj, 'README.md'), 'hello\n')
  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'one\ntwo\nthree\n')
  fs.writeFileSync(path.join(proj, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
  git(proj, 'add', '-A')
  git(proj, 'commit', '-qm', 'init')
  // 1.0.0: one commit changing, adding (251 files) and deleting, then 119 more as a terminal would make them.
  git(proj, 'checkout', '-q', '-b', '1.0.0')
  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'one\nTWO on 1.0.0\nthree\n')
  fs.writeFileSync(path.join(proj, 'logo.bin'), Buffer.from([0, 9, 9, 9]))
  fs.mkdirSync(path.join(proj, 'many'))
  for (let i = 0; i < 251; i++) fs.writeFileSync(path.join(proj, 'many', `f${String(i).padStart(3, '0')}.txt`), `${i}\n`)
  fs.rmSync(path.join(proj, 'README.md'))
  git(proj, 'add', '-A')
  git(proj, 'commit', '-qm', '1.0.0 work 1')
  let tip = git(proj, 'rev-parse', 'HEAD')
  for (let i = 2; i <= 120; i++) tip = git(proj, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', `1.0.0 work ${i}`)
  git(proj, 'update-ref', 'refs/heads/1.0.0', tip)
  // main: one commit of its own, checked out, with an edit not committed: the comparison neither reads nor touches it.
  git(proj, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(proj, 'main-only.txt'), 'main\n')
  git(proj, 'add', '-A')
  git(proj, 'commit', '-qm', 'main only')
  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'edited, not committed\n')

  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 860 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await inv('workflow:setOptions', proj, { preset: null, options: { target: '1.0.0' } })
  const before = state()
  const text = (loc) => loc.innerText().catch(() => '')
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
  }
  const shots = async (name) => {
    await page.mouse.move(5, 5)
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.screenshot({ path: path.join(lib.WORK, `changescompare-${name}-${t}.png`) })
    }
    await theme('dark')
  }

  // --- The default: 1.0.0 against main, the picker's first entry.
  await page.getByText('proj', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Version Control' }).click()
  const cmp = page.locator('[data-compare-page]')
  const picker = page.locator('.split-list .changes-picker')
  const on = async (base, head) => (await cmp.count()) === 1 && (await cmp.getAttribute('data-compare-base')) === base && (await cmp.getAttribute('data-compare-head')) === head
  check('Changes opens on 1.0.0 against main (the project’s target against main)', !!(await lib.until(() => on('main', '1.0.0'), HUNG_MS)), await text(page.locator('.split-main')))
  const first = await picker.locator('option').first()
  check('…the picker’s first entry, selected, under Branches', (await picker.inputValue()) === 'compare:main:1.0.0' && (await first.getAttribute('value')) === 'compare:main:1.0.0' && (await first.innerText()) === '1.0.0 ↔ main' && ((await picker.locator('optgroup').first().getAttribute('label')) ?? '').startsWith('Branches'), JSON.stringify(await picker.locator('option').allInnerTexts()))
  const counts = page.locator('[data-compare-ahead]')
  check('120 commits 1.0.0 has that main hasn’t, 1 the other way', !!(await lib.until(async () => (await counts.getAttribute('data-compare-ahead').catch(() => null)) === '120' && (await counts.getAttribute('data-compare-behind')) === '1', HUNG_MS)) && /1\.0\.0 has 120 commits main hasn’t; main has 1 commit 1\.0\.0 hasn’t\./.test(await text(counts)), await text(counts))

  // --- The files: 254, 200 listed until Show more, and a diff when one is opened.
  const files = page.locator('[data-compare-file]')
  check('the files 1.0.0 changes since it left main: 254, 200 listed', (await page.locator('[data-compare-files]').getAttribute('data-compare-files')) === '254' && (await files.count()) === 200, String(await files.count()))
  check('…not main’s own file', (await page.locator('[data-compare-file="main-only.txt"]').count()) === 0)
  await page.getByRole('button', { name: /Show more \(200 of 254\)/ }).click()
  check('Show more lists the rest', !!(await lib.until(async () => (await files.count()) === 254, HUNG_MS)), String(await files.count()))
  check('no file’s diff is read until one is opened', (await page.locator('[data-compare-diff]').count()) === 0 && /Select a file/.test(await text(page.locator('.split-main'))))
  await page.locator('[data-compare-file="src/a.txt"]').scrollIntoViewIfNeeded()
  await page.locator('[data-compare-file="src/a.txt"]').click()
  const diff = page.locator('[data-compare-diff="src/a.txt"]')
  // Monaco shows a space as a no-break space.
  const diffText = async () => (await text(diff)).replace(/ /g, ' ')
  check('opening src/a.txt shows its diff: main’s where 1.0.0 left it against 1.0.0’s (never the uncommitted edit)', !!(await lib.until(async () => /TWO on 1\.0\.0/.test(await diffText()) && /\btwo\b/.test(await diffText()), HUNG_MS)) && !/edited, not committed/.test(await diffText()), await diffText())
  await shots('files')
  await page.locator('[data-compare-file="logo.bin"]').click()
  check('a binary file says so', !!(await lib.until(async () => /binary file/i.test(await text(page.locator('[data-compare-diff="logo.bin"]'))), HUNG_MS)))

  // --- The commits, 50 a page.
  await page.locator('[data-compare-view="commits"]').click()
  const commits = page.locator('[data-compare-commits]')
  check('Commits lists each side’s: 50 of 1.0.0’s on the first page, and main’s one', !!(await lib.until(async () => (await commits.locator('.git-commit').count()) === 51, HUNG_MS)) && /1\.0\.0 work 120/.test(await text(commits.locator('.git-commit').first())) && /main only/.test(await text(commits)) && /Page 1 of 3/.test(await text(commits.locator('.table-paging'))), await text(commits))
  await shots('commits')
  await commits.locator('[aria-label="Next page"]').click()
  check('…the next page, the next 50 of 1.0.0’s', !!(await lib.until(async () => /Page 2 of 3/.test(await text(commits.locator('.table-paging'))) && /1\.0\.0 work 70/.test(await text(commits.locator('.git-commit').first())), HUNG_MS)), await text(commits.locator('.git-commit').first()))

  // --- Swap: main against 1.0.0.
  await page.locator('[data-action="compare-swap"]').click()
  check('Swap compares the other way: main’s 1 commit, its 1 file', !!(await lib.until(async () => (await on('1.0.0', 'main')) && (await counts.getAttribute('data-compare-ahead').catch(() => null)) === '1' && (await counts.getAttribute('data-compare-behind')) === '120' && (await files.count()) === 1 && (await page.locator('[data-compare-file="main-only.txt"]').count()) === 1, HUNG_MS)), `${await text(counts)} / ${await files.allInnerTexts()}`)
  check('…the picker shows that pair', (await picker.inputValue()) === 'compare:1.0.0:main')

  // --- Refused, and nothing changed.
  const refused = await inv('git:compare', proj, 'main', '--output=x').then(() => 'answered', (e) => String(e?.message ?? e))
  check('a name that isn’t a branch is refused, never taken as an option', /no branch --output=x/.test(refused), refused)
  check('nothing in the repository changed: refs, index, working tree, worktrees', state() === before)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
