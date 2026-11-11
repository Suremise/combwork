// A change left uncommitted where the target is checked out (HI-2944): a project set to "Combwork merges" into `main`,
// checked out in the project folder, fake Claude Code agents acting by their own tokens (queueFixture's), the Assistant
// off. Darren's case, end to end:
// - Files → Exclude from Git on a folder, shared: .gitignore changed, left uncommitted; the menu says which choice needs a
//   commit, and the notification offers Commit It.
// - A lane started for a card that also changes .gitignore: the window is told before work starts (Commit, Set Aside,
//   Show Changes), and the builder's start says so too.
// - The card's merge pauses naming .gitignore; the paused merge (Merges tab, the card's Work section) offers Commit and
//   Set Aside; Commit commits just .gitignore and the merge goes on: Done, both lines in .gitignore.
// - A second card's merge paused on the user's staged keep.txt: Set Aside in its Work section stashes it, named after
//   the card, and the merge goes on.
// - Exclude again, with another file changed: Commit It commits .gitignore alone.
// Screenshots of the menu, the warning, the paused merge and the card's Work section, both themes. Dev build, throwaway
// profiles, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47849))
const fx = q.queueProject('foldercommit')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every wait here is bounded only against a hang (#570).
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const f = q.folderHelpers(fx)
const git = (...a) => lib.git(fx.alpha, a).trim()
const lastCommitFiles = () => git('show', '--no-renames', '--name-only', '--format=', 'HEAD').split(/\r?\n/).filter(Boolean)

;(async () => {
  q.prepare(fx)
  // .gitignore with lines between where the user's line goes (the end) and the card's (the top): git merges them.
  fs.writeFileSync(path.join(fx.alpha, '.gitignore'), '.combwork/\nnode_modules/\ndist/\n')
  fs.writeFileSync(path.join(fx.alpha, 'keep.txt'), 'kept\n')
  git('add', '-A')
  git('commit', '-qm', 'ignore rules')
  fs.mkdirSync(path.join(fx.alpha, 'reference'), { recursive: true })
  fs.writeFileSync(path.join(fx.alpha, 'reference', 'doc.md'), '# docs\n')
  fs.mkdirSync(path.join(fx.alpha, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(fx.alpha, 'notes', 'n.md'), 'n\n')
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  const page = h.page
  try {
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: f.options() })
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const reviewer = await q.agent(fx, h, 'R1')
    const builder = await q.agent(fx, h, 'B1')
    q.steer(fx, 'pass')
    const queue = async () => (await h.inv('queue:list', fx.alpha, 'main'))[0]
    const toast = (text) => page.locator('.toast').filter({ hasText: text })

    // --- Files → Exclude from Git, shared: the menu says which needs a commit; the notification offers Commit It.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tab', { hasText: 'Files' }).click()
    const row = (rel) => page.locator(`.file-row[data-rel="${rel}"]`)
    const menuItem = (text) => page.locator('.menu .menu-item', { hasText: text })
    await waitHung(async () => (await row('reference').count()) === 1)
    await row('reference').click({ button: 'right' })
    await waitHung(async () => (await page.locator('.menu .menu-header', { hasText: 'Git' }).count()) > 0)
    await menuItem('Exclude from Git').click()
    const shared = page.locator('.menu .menu-header', { hasText: 'Shared with the repository (a commit)' })
    check('Exclude from Git: the shared choice says it is a commit, the local one that it isn\'t', !!(await waitHung(async () => (await shared.count()) === 1)) && (await page.locator('.menu .menu-header', { hasText: 'Only on this PC (nothing to commit)' }).count()) === 1)
    await f.themes(page, page.locator('.menu').last(), 'foldercommit-exclude-menu')
    await menuItem('This folder').first().click()
    check('…This folder, shared: /reference/ added to .gitignore, left uncommitted', !!(await waitHung(() => f.text('.gitignore') === '.combwork/\nnode_modules/\ndist/\n/reference/\n')) && /M \.gitignore/.test(git('status', '--porcelain')), JSON.stringify(f.text('.gitignore')))
    const excluded = toast('Added /reference/ to .gitignore')
    check('…its notification offers Commit It, and says Commit It commits .gitignore as it is now', !!(await waitHung(async () => (await excluded.getByRole('button', { name: 'Commit It' }).count()) === 1)) && /as it is now/.test(await excluded.innerText()), await excluded.innerText().catch(() => ''))
    await f.themes(page, excluded, 'foldercommit-exclude-toast')
    // Left uncommitted, as Darren's was: the notification closed.
    await excluded.locator('.popup-close').first().click().catch(() => undefined)

    // --- A lane for a card that also changes .gitignore: told before work starts.
    const n = (await h.inv('tasks:create', { title: 'Ignore out', project: 'alpha' })).number
    const lane = await h.inv('lanes:start', fx.alpha, { builder: builder.id, reviewer: reviewer.id, cards: [n] })
    check('the lane starts', !!lane && !lane.error, JSON.stringify(lane))
    const warned = toast('Uncommitted changes where main is checked out')
    const button = (name) => warned.first().getByRole('button', { name, exact: true })
    const counts = async () => [await warned.count(), await button('Commit').count(), await button('Set Aside').count(), await button('Show Changes').count()]
    check('lane start: the window is told, naming .gitignore, with Commit, Set Aside and Show Changes', !!(await waitHung(async () => (await warned.count()) >= 1 && /\.gitignore/.test(await warned.first().innerText()) && (await counts()).slice(1).every((c) => c === 1))), JSON.stringify(await counts()))
    await f.themes(page, warned.first(), 'foldercommit-start-warning')
    check('…nothing was committed or refused: .gitignore still changed in the folder', /M \.gitignore/.test(git('status', '--porcelain')))
    Object.assign(builder, await q.renewed(fx, h, builder))
    const a = await q.approveCard(fx, h, builder, reviewer, n, 'Ignore out', { '.gitignore': 'out/\n.combwork/\nnode_modules/\ndist/\n' })
    check('the card is approved (start, submit, review, pass)', Object.values(a.steps).every((s) => s.status === 200), JSON.stringify(a.steps))
    // (The lane started the card for B1, and that start told the window above; B1's own start is then a carry-on. The
    // agent's Warning line is the runtime's unit test's, queueFolder.test.ts.)

    // --- The merge pauses naming .gitignore; Commit on the paused merge, and it goes on.
    const p = await waitHung(async () => ((await queue())?.paused?.reason === 'unstagedChanges' ? (await queue()).paused : null))
    check("the card's merge pauses on the uncommitted .gitignore, naming it", JSON.stringify(p?.files) === '[".gitignore"]', JSON.stringify(p))
    // The card's Work section: the pause with Commit and Set Aside.
    await q.showBoard(page)
    await q.openByTitle(page, n)
    const dialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    const paused = dialog.locator('.card-work-queue-paused')
    check("the card's Work section: the pause, with Commit and Set Aside", !!(await waitHung(async () => (await paused.locator('[data-action="commit-changes"]').count()) === 1 && (await paused.locator('[data-action="set-aside-changes"]').count()) === 1)) && /\.gitignore/.test(await paused.innerText()), await paused.innerText().catch(() => ''))
    await f.themes(page, paused, 'foldercommit-card-paused')
    await page.keyboard.press('Escape')
    // The Merges tab: the same buttons; Commit there.
    const m = await q.mergesTab(h)
    const commitBtn = m.card('main').locator('[data-action="commit-changes"]')
    check('the Merges tab: the paused merge names .gitignore, with Commit and Set Aside', !!(await waitHung(async () => (await commitBtn.count()) === 1)) && (await m.card('main').locator('[data-action="set-aside-changes"]').count()) === 1 && /\.gitignore/.test(await m.text('main')), await m.text('main'))
    await f.themes(page, m.card('main'), 'foldercommit-merges-paused')
    const before = git('rev-parse', 'HEAD')
    await commitBtn.click()
    const ours = () => git('log', '--format=%H', '--grep=Commit changes before merging', `${before}..HEAD`)
    check('Commit: .gitignore alone committed in the project folder, its message naming the card', !!(await waitHung(() => ours() || null)) && git('show', '--no-renames', '--name-only', '--format=', ours().split(/\s+/)[0]) === '.gitignore', git('log', '--format=%h %s', `${before}..HEAD`))
    check('…and the merge goes on: Done, both lines in .gitignore', !!(await waitHung(async () => (await h.card(n))?.column === 'done')) && f.text('.gitignore') === 'out/\n.combwork/\nnode_modules/\ndist/\n/reference/\n', JSON.stringify(f.text('.gitignore')))
    check('…the folder clean', git('status', '--porcelain', '--untracked-files=no') === '', git('status', '--porcelain'))

    // --- Staged: the user's staged change pauses the next card's merge; Set Aside in the card's Work section, and it goes on.
    fs.writeFileSync(path.join(fx.alpha, 'keep.txt'), 'kept, and the user staged this\n')
    git('add', 'keep.txt')
    Object.assign(builder, await q.renewed(fx, h, builder))
    const b = await q.approveBy(fx, h, builder, reviewer, 'Keep more', { 'keep.txt': 'kept\nby the card\n' })
    check('a second card is approved', Object.values(b.steps).every((s) => s.status === 200), JSON.stringify(b.steps))
    const ps = await waitHung(async () => ((await queue())?.paused?.reason === 'staged' ? (await queue()).paused : null))
    check('its merge pauses on the staged keep.txt, naming it', JSON.stringify(ps?.files) === '["keep.txt"]', JSON.stringify(ps))
    await q.showBoard(page)
    await q.openByTitle(page, b.n)
    const pausedB = dialog.locator('.card-work-queue-paused')
    const aside = pausedB.locator('[data-action="set-aside-changes"]')
    check("the card's Work section: the staged pause, with Set Aside", !!(await waitHung(async () => (await aside.count()) === 1)) && /keep\.txt is staged|keep\.txt are staged/.test(await pausedB.innerText()), await pausedB.innerText().catch(() => ''))
    await f.themes(page, pausedB, 'foldercommit-card-staged')
    await aside.click()
    const keyB = (await h.card(b.n))?.key
    check('Set Aside: keep.txt kept in a stash named after the card, the index clean', !!(await waitHung(() => new RegExp(`Combwork: set aside before merging ${keyB}`).test(git('stash', 'list', '--format=%s')) || null)) && git('diff', '--cached', '--name-only') === '', git('stash', 'list', '--format=%s'))
    check('…and the merge goes on: Done, keep.txt as the card made it', !!(await waitHung(async () => (await h.card(b.n))?.column === 'done')) && f.text('keep.txt') === 'kept\nby the card\n', JSON.stringify(f.text('keep.txt')))
    check('…the user\'s staged change is in the stash', git('show', 'stash@{0}:keep.txt') === 'kept, and the user staged this', git('show', 'stash@{0}:keep.txt'))
    await page.keyboard.press('Escape')

    // --- Exclude again, another file changed beside it: Commit It commits .gitignore alone.
    fs.writeFileSync(path.join(fx.alpha, 'keep.txt'), 'the user is editing this\n')
    // Back to the project's tabs (the board was shown, for the card's dialog).
    await page.getByRole('button', { name: 'Projects' }).click()
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tab', { hasText: 'Files' }).click()
    await waitHung(async () => (await row('notes').count()) === 1)
    await row('notes').click({ button: 'right' })
    await waitHung(async () => (await menuItem('Exclude from Git').count()) === 1)
    await menuItem('Exclude from Git').click()
    await waitHung(async () => (await shared.count()) === 1)
    await menuItem('This folder').first().click()
    const second = toast('Added /notes/ to .gitignore')
    await waitHung(async () => (await second.getByRole('button', { name: 'Commit It' }).count()) === 1)
    const at = git('rev-parse', 'HEAD')
    await second.getByRole('button', { name: 'Commit It' }).click()
    check('Commit It: .gitignore alone committed, keep.txt still changed', !!(await waitHung(() => git('rev-parse', 'HEAD') !== at || null)) && JSON.stringify(lastCommitFiles()) === '[".gitignore"]' && git('log', '-1', '--format=%s') === 'Update .gitignore' && /M keep\.txt/.test(git('status', '--porcelain')), `${JSON.stringify(lastCommitFiles())} ${git('status', '--porcelain')}`)
    check('…the line committed as written', git('show', 'HEAD:.gitignore').replace(/\r\n/g, '\n').endsWith('/reference/\n/notes/'), git('show', 'HEAD:.gitignore'))
    git('checkout', '--', 'keep.txt')
  } catch (e) {
    check('no unexpected error', false, e.stack || String(e))
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(`screenshots: ${fx.shots}`)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
