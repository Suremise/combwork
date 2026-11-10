// A moved submodule in the window (HI-2864, design HI-2864/s10). A project with a local file:// submodule at
// `lib/[x] sub` (a path with brackets and a space) whose work goes to 1.5.0: a card's commit on 1.5.0 moves the gitlink
// from A to B, and the checkout is then moved on to C, not committed. Changes → Compare (1.5.0 against main) shows the
// file as one row, "Submodule lib/[x] sub: <A> → <B>", with git's own lines on Show git's diff; Changes on the project
// folder shows "<B> → <C>"; the card, moved to Review by the user, shows the row in its Work section's files. An ordinary
// file beside it still shows its diff. Screenshots of each in both themes. Throwaway profile and workspace, the
// repositories made with the suite's own git; quiet; no agent is started.
const lib = require('./lib.cjs')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'submodulediff-profile')
const ws = path.join(lib.WORK, 'submodulediff-ws')
const subRepo = path.join(lib.WORK, 'submodulediff-sub')
const proj = path.join(ws, 'proj')
const SUB = 'lib/[x] sub'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// The file protocol is allowed for the fixture's own git only (the submodule's add and checkouts); Combwork never needs it.
const git = (cwd, ...a) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'protocol.file.allow=always', ...a]).trim()
const commitFile = (dir, file, text, message) => {
  fs.writeFileSync(path.join(dir, file), text)
  git(dir, 'add', '--', file)
  git(dir, 'commit', '-qm', message)
  return git(dir, 'rev-parse', 'HEAD')
}

;(async () => {
  for (const d of [userData, ws, subRepo]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(subRepo, { recursive: true })
  git(subRepo, 'init', '-q', '-b', 'main')
  const A = commitFile(subRepo, 's.txt', 'a\n', 'A')
  const B = commitFile(subRepo, 's.txt', 'b\n', 'B')
  const C = commitFile(subRepo, 's.txt', 'c\n', 'C')
  fs.mkdirSync(proj, { recursive: true })
  git(proj, 'init', '-q', '-b', 'main')
  commitFile(proj, 'a.txt', 'one\n', 'init')
  git(proj, 'submodule', 'add', '-q', pathToFileURL(subRepo).href, SUB)
  git(path.join(proj, SUB), 'checkout', '-q', A)
  git(proj, 'add', '--', SUB)
  git(proj, 'commit', '-qm', 'add the submodule at A')
  git(proj, 'checkout', '-q', '-b', '1.5.0')

  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 860 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await inv('workflow:setOptions', proj, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project', target: '1.5.0' } })
  const text = async (loc) => (await loc.innerText().catch(() => '')).replace(/\s+/g, ' ')
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
  }
  const shots = async (name, loc = page) => {
    await page.mouse.move(5, 5)
    for (const t of ['dark', 'light']) {
      await theme(t)
      await loc.screenshot({ path: path.join(lib.WORK, `submodulediff-${name}-${t}.png`) })
    }
    await theme('dark')
  }

  // --- The card: started (its base is 1.5.0's commit now), then the commit moving the gitlink to B, then Review.
  const builder = await lib.addAgent(inv, proj, { name: 'B1' })
  const n = (await inv('tasks:create', { title: 'Move the submodule', project: 'proj', agent: builder.id, column: 'todo' })).number
  await inv('tasks:move', n, 'doing', {})
  git(path.join(proj, SUB), 'checkout', '-q', B)
  git(proj, 'add', '--', SUB)
  fs.writeFileSync(path.join(proj, 'a.txt'), 'two\n')
  git(proj, 'add', '--', 'a.txt')
  git(proj, 'commit', '-qm', 'move the submodule to B')
  const moved = await inv('tasks:move', n, 'review', {}).catch((e) => ({ error: String(e?.message ?? e) }))
  check('the user moves the card to Review', (await inv('tasks:list')).find((c) => c.number === n)?.column === 'review', JSON.stringify(moved))
  let last = null
  const work = await lib.until(async () => {
    const v = (last = await inv('tasks:work', n))
    return v?.revisions?.length === 1 && v.revisions[0].files.length === 2 && v
  }, HUNG_MS)
  const recorded = work ? work.revisions[0].files.find((f) => f.path === SUB) : null
  check('the submission records the gitlink’s sides with its files', !!work && JSON.stringify(recorded?.gitlink) === JSON.stringify({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: B } }) && !work.revisions[0].files.find((f) => f.path === 'a.txt')?.gitlink, JSON.stringify(last))
  // Moved on to C, not committed: the project folder's Changes shows B → C.
  git(path.join(proj, SUB), 'checkout', '-q', C)

  // --- Changes → Compare: 1.5.0 against main, the picker's first entry.
  await page.getByText('proj', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Version Control' }).click()
  const cmp = page.locator('[data-compare-page]')
  check('Changes opens on 1.5.0 against main', !!(await lib.until(async () => (await cmp.count()) === 1 && (await cmp.getAttribute('data-compare-head')) === '1.5.0', HUNG_MS)), await text(page.locator('.split-main')))
  const subFile = page.locator(`[data-compare-file="${SUB}"]`)
  await lib.until(async () => (await subFile.count()) === 1, HUNG_MS)
  await subFile.click()
  const row = page.locator(`[data-compare-diff="${SUB}"] [data-gitlink-diff="${SUB}"] [data-gitlink="${SUB}"]`)
  const want = `Submodule ${SUB}: ${A.slice(0, 7)} → ${B.slice(0, 7)}`
  check('Compare shows the submodule as one row, its short ids', !!(await lib.until(async () => (await text(row)) === want, HUNG_MS)), await text(page.locator('.split-main')))
  check('…its full ids in the tooltip', (await row.getAttribute('title')) === `Submodule ${SUB}: ${A} → ${B}`, await row.getAttribute('title'))
  check('…and no editor until git’s diff is asked for', (await page.locator(`[data-gitlink-git="${SUB}"]`).count()) === 0)
  await shots('compare')
  await page.getByRole('button', { name: 'Show git’s diff' }).click()
  const gitLines = page.locator(`[data-gitlink-git="${SUB}"]`)
  const gitText = async () => (await text(gitLines)).replace(/ /g, ' ')
  check('Show git’s diff shows git’s own Subproject commit lines', !!(await lib.until(async () => (await gitText()).includes(`Subproject commit ${A}`) && (await gitText()).includes(`Subproject commit ${B}`), HUNG_MS)), await gitText())
  await shots('compare-git')
  await page.locator('[data-compare-file="a.txt"]').click()
  check('an ordinary file beside it shows its diff as before', !!(await lib.until(async () => /\btwo\b/.test((await text(page.locator('[data-compare-diff="a.txt"]'))).replace(/ /g, ' ')), HUNG_MS)) && (await page.locator('[data-gitlink-diff]').count()) === 0)

  // --- Changes on the project folder: the checkout moved on to C, not committed.
  await page.locator('.split-list .changes-picker').selectOption('')
  const changesRow = page.locator('.split-list .row', { hasText: 'sub' })
  check('the project folder lists the submodule as changed', !!(await lib.until(async () => (await changesRow.count()) === 1, HUNG_MS)), await text(page.locator('.split-list')))
  await changesRow.click()
  const folderRow = page.locator(`.split-main [data-gitlink-diff="${SUB}"] [data-gitlink="${SUB}"]`)
  check('Changes shows B → C (git’s own word for where the checkout is)', !!(await lib.until(async () => (await text(folderRow)) === `Submodule ${SUB}: ${B.slice(0, 7)} → ${C.slice(0, 7)}`, HUNG_MS)), await text(page.locator('.split-main')))
  await shots('changes')

  // --- The card's Work section: its files, the row in place of the path.
  await showBoard(page)
  await openByTitle(page, n)
  const dialog = lib.cardDialog(page, await lib.cardLabel(inv, n))
  await dialog.waitFor({ timeout: HUNG_MS })
  const section = dialog.locator('.card-work[data-work="recorded"]')
  await section.waitFor({ timeout: HUNG_MS })
  await section.locator('.card-work-rev').first().getByRole('button', { name: '2 files changed' }).click()
  const workRow = section.locator(`.card-work-files [data-gitlink="${SUB}"]`)
  check('the Work section’s files show the submodule as its row', !!(await lib.until(async () => (await text(workRow)) === want, HUNG_MS)), await text(section))
  check('…and the ordinary file by its path', (await section.locator('.card-work-files li', { hasText: 'a.txt' }).count()) === 1)
  await section.scrollIntoViewIfNeeded()
  await shots('work', section)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
