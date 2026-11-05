// Unused worktrees (#353, in the Changes tab since #400): an agent removed with "Keep worktree and branch" leaves its
// worktree, said once in a notice whose Review opens Changes at "Unused worktrees (n)" (the folder picker's "All unused
// worktrees"). A merged, clean one is removed there with its branch; one with unmerged work shows its commits, has no
// plain Remove and no Give to an agent… (#1555: no agent is given a worktree in 1.0), offers Remove anyway… (a danger
// confirm naming what goes), and Open shows its changes like an agent's worktree, with Merge (the Merge dialog). The
// Overview has one line linking there; Changes' project folder says so only while one holds work; Storage has a line
// for them; the Agent API's project status counts them for the Assistant (no way to remove them). Without git, nothing is
// removed. Then one is merged from Changes and removed after (its commit on the main branch, its folder and branch gone). A throwaway repository with worktree agents
// added through Combwork (not started), fake Claude Code configured, throwaway profile and workspace, quiet.
// Dev build only (#1580): 0.9 worktrees on purpose: Merged, Ahead and Claudette are 0.9 worktree agents
// (agents:testLegacy, refused by a packaged build), whose worktrees are left unused.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'unusedwt-profile')
const ws = path.join(lib.WORK, 'unusedwt-ws')
const repo = path.join(ws, 'repo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** The run context's PATH for a test copy without the folders that hold git. */
function pathWithoutGit() {
  const env = lib.hiveEnv({ CW_USER_DATA: userData })
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (env[key] ?? '')
    .split(path.delimiter)
    .filter((d) => d && !['git.exe', 'git.com'].some((g) => fs.existsSync(path.join(d.replace(/^"|"$/g, ''), g))))
    .join(path.delimiter)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(repo)
  const main = lib.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  // "How do you work?" answered (#1423), as a user does once: its step would take the tab's room this suite measures.
  await inv('workflow:presetNotNow', repo, 'git')
  await lib.waitForProvider(inv)
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `unusedwt-${name}.png`) })
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    // The window shows it before a screenshot is taken (a condition, never a fixed wait).
    if (!(await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS))) throw new Error(`the window didn't show the ${t} theme`)
  }
  const toasts = async (re) => (await page.locator('.toast').allInnerTexts()).filter((t) => re.test(t)).length
  const branches = () => lib.git(repo, ['branch', '--format=%(refname:short)']).split(/\r?\n/).filter(Boolean)

  // Three worktree agents; Ahead commits work of its own.
  const merged = await lib.addAgent(inv, repo, { name: 'Merged', location: 'new-worktree' })
  const ahead = await lib.addAgent(inv, repo, { name: 'Ahead', location: 'new-worktree' })
  const claudette = await lib.addAgent(inv, repo, { name: 'Claudette', location: 'new-worktree' })
  fs.writeFileSync(path.join(ahead.worktree.path, 'work.txt'), 'work\n')
  lib.git(ahead.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
  lib.git(ahead.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Unmerged work'])
  check('three worktree agents, and none unused yet', (await inv('worktrees:unused', repo)).worktrees.length === 0)

  // --- Remove Merged from its tab, keeping its worktree: one notice, with Review.
  await page.getByText('repo', { exact: true }).first().click()
  await lib.agentMenu(page, 'Merged')
  await page.locator('.menu-item', { hasText: 'Remove Agent…' }).click()
  await page.locator('.dialog').getByRole('button', { name: 'Keep worktree and branch' }).click()
  const keptToast = /Merged's worktree is kept/
  check('removing it keeping its worktree says so once', !!(await lib.until(async () => (await toasts(keptToast)) === 1, 10000)), String(await toasts(keptToast)))
  await inv('agents:remove', repo, ahead.id, { deleteWorktree: false })
  await lib.sleep(500)
  check('…once only', (await toasts(keptToast)) === 1)

  // --- Review: the Changes tab's list of them (#400).
  await page.locator('.toast', { hasText: keptToast }).getByRole('button', { name: 'Review unused worktrees' }).click()
  const section = page.locator('.unused-worktrees-pane .unused-worktrees')
  check('Review opens Changes at Unused worktrees (2)', !!(await lib.until(async () => (await section.count()) === 1 && /Unused worktrees\s*2/.test(await section.locator('h2').innerText()), 10000)) && (await page.locator('.tab.active, .tab[aria-selected="true"]', { hasText: 'Version Control' }).count()) >= 1, await section.innerText().catch(() => ''))
  const picker = page.locator('.split-list .root-select')
  check('…the folder picker shows "Unused worktrees (2)", first, in its group (#476)', (await picker.inputValue()) === 'unused' && (await picker.locator('optgroup[label^="Unused worktrees"] option').allInnerTexts()).join('|').includes('Unused worktrees (2)') && (await picker.locator('option').evaluateAll((os) => os.map((o) => o.value).find((v) => !(v.startsWith('compare:') || v === 'leftovers')))) === 'unused', (await picker.locator('option').allInnerTexts()).join('|'))
  check('…each made by Combwork (its agent never ran a session there)', (await section.locator('[data-origin="hive"]').count()) === 2, await section.innerText().catch(() => ''))
  check('…and says what they are', (await section.locator('.info-icon, [aria-label*="info" i]').count()) >= 1)
  // Its ⓘ says where they come from, without promising a template gives them back (#1562: 1.0's agents get no worktree).
  await section.locator('h2 .info-icon').first().hover()
  const tipText = async () => (await page.locator('.tip:visible').allInnerTexts()).join(' ')
  check('…its ⓘ: removed agents (by hand or by a template), made outside Combwork, which can go; no template gives them back', !!(await lib.until(async () => /when a template's agents replaced it.*made outside Combwork.*Loading a template gives none of them to its agents\. Those merged into/s.test(await tipText()), 5000)) && !/gives them back/.test(await tipText()), await tipText())
  await shot('changes-tip')
  await page.mouse.move(0, 0)
  const row = (wt) => section.locator(`.unused-wt[data-path="${wt.worktree.path.replace(/\\/g, '\\\\')}"]`)
  const mergedRow = row(merged)
  const aheadRow = row(ahead)
  check(`the merged one: "Merged into ${main} · clean", with Remove`, (await mergedRow.innerText()).includes(`Merged into ${main} · clean`) && (await mergedRow.getByRole('button', { name: 'Remove', exact: true }).count()) === 1, await mergedRow.innerText().catch(() => ''))
  check(`the unmerged one: "1 commit not on ${main}", its last commit, no plain Remove`, (await aheadRow.innerText()).includes(`1 commit not on ${main}`) && (await aheadRow.innerText()).includes('Unmerged work') && (await aheadRow.getByRole('button', { name: 'Remove', exact: true }).count()) === 0, await aheadRow.innerText().catch(() => ''))
  check('…Remove anyway…, and no Give to an agent… (#1555)', (await aheadRow.getByRole('button', { name: 'Give to an agent…' }).count()) === 0 && (await aheadRow.getByRole('button', { name: 'Remove anyway…' }).count()) === 1)
  check('sizes are measured', !!(await lib.until(async () => /\d+(\.\d+)? (B|KB|MB)/.test(await mergedRow.innerText()), 15000)), await mergedRow.innerText())
  check('Remove all merged (1)…', (await section.getByRole('button', { name: 'Remove all merged (1)…' }).count()) === 1)
  // No badge is ever cut (the Assistant's OK on #1314): each shows its whole text inside its cell, at every width.
  const badgesWhole = () =>
    page.evaluate(() => {
      const badges = [...document.querySelectorAll('.unused-wt .unused-wt-badges .badge')]
      return (
        badges.length > 0 &&
        badges.every((b) => {
          const cell = b.closest('td').getBoundingClientRect()
          const r = b.getBoundingClientRect()
          return b.scrollWidth <= b.clientWidth + 1 && r.left >= cell.left - 0.5 && r.right <= cell.right + 0.5
        })
      )
    })
  check('…every state badge whole, none cut (1400 px)', !!(await lib.until(badgesWhole, HUNG_MS)))
  await shot('changes-list-dark')
  await theme('light')
  await shot('changes-list-light')
  await theme('dark')

  // --- A narrow window with the Projects sidebar, Progress and the Assistant's rail (#906): the list goes above the
  // detail, which keeps the tab's width (not squeezed to nothing behind Progress), its buttons clickable; then a wide one
  // as before, the list beside it.
  const command = (id, ...args) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: id, args })
  const layout = () =>
    page.evaluate(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null
      const [split, list, heading, progress] = ['.changes-split', '.changes-split .split-list', '#unused-worktrees', '.progress-panel'].map(box)
      const pane = document.querySelector('.unused-worktrees-pane')
      if (!split || !list || !heading || !pane) return null
      return { split: Math.round(split.width), list: Math.round(list.width), heading: Math.round(heading.width), stacked: list.bottom <= heading.top, beside: list.right <= heading.left, inside: heading.left >= split.left && heading.right <= split.right + 0.5 && (!progress || split.right <= progress.left + 0.5), scrolls: pane.scrollWidth > pane.clientWidth + 1 }
    })
  const progressShown = () => page.locator('.progress-panel').count()
  if (!(await progressShown())) await command('progress.toggle')
  await lib.fitWindow(app, page, { width: 900, height: 860 })
  let narrow = null
  check('a narrow window with Progress open: the list above the detail, which keeps the tab\'s width inside it (#906)', !!(await lib.until(async () => (narrow = await layout()) !== null && (await progressShown()) === 1 && narrow.split < 520 && narrow.stacked && narrow.inside && narrow.heading > 150 && !narrow.scrolls, HUNG_MS)), JSON.stringify(narrow))
  check('…its rows\' buttons can be clicked (none under Progress)', await aheadRow.getByRole('button', { name: 'Remove anyway…' }).click({ trial: true, timeout: HUNG_MS }).then(() => true, () => false))
  // Each row stacks in the narrow pane (#1314), its buttons wrapping inside it, none cut off at either edge.
  const buttonsInside = () =>
    page.evaluate(() => {
      const pane = document.querySelector('.unused-worktrees')?.getBoundingClientRect()
      const buttons = [...document.querySelectorAll('.unused-wt .item-table-actions button')].map((b) => b.getBoundingClientRect())
      return !!pane && buttons.length > 0 && buttons.every((b) => b.left >= pane.left - 0.5 && b.right <= pane.right + 0.5)
    })
  check('…every row’s buttons inside the pane', !!(await lib.until(buttonsInside, HUNG_MS)))
  check('…every state badge whole there too', !!(await lib.until(badgesWhole, HUNG_MS)))
  await shot('changes-list-narrow')
  await command('progress.toggle')
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  let wide = null
  check('…a wide window: the list beside the detail again, at its own width', !!(await lib.until(async () => (wide = await layout()) !== null && (await progressShown()) === 0 && wide.beside && wide.list === 280 && wide.inside && !wide.scrolls, HUNG_MS)), JSON.stringify(wide))
  // A very wide one (#1314): a line a worktree, its columns headed, its actions at the right edge, aligned.
  await lib.fitWindow(app, page, { width: 1900, height: 900 })
  const oneLine = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('.unused-wt')].map((r) => r.getBoundingClientRect())
      const head = document.querySelector('.unused-wt-table thead')
      const actions = [...document.querySelectorAll('.unused-wt .item-table-actions')].map((a) => Math.round(a.getBoundingClientRect().right))
      return rows.length === 2 && rows.every((r) => r.height < 36) && !!head && getComputedStyle(head).display !== 'none' && new Set(actions).size === 1
    })
  check('…wider still: a line a worktree under the column headings, actions aligned at the right', !!(await lib.until(oneLine, HUNG_MS)))
  check('…every state badge whole there too', !!(await lib.until(badgesWhole, HUNG_MS)))
  await shot('changes-list-wide-dark')
  await theme('light')
  await shot('changes-list-wide-light')
  await theme('dark')
  await lib.fitWindow(app, page, { width: 1400, height: 900 })

  // Remove all merged's confirmation (#1314): the worktrees as a table, Branch · Folder (the folder's name, its path in full on hover).
  await section.getByRole('button', { name: 'Remove all merged (1)…' }).click()
  const mergedDialog = page.locator('.dialog', { hasText: 'Remove 1 merged worktree?' })
  check('Remove all merged asks first, its worktrees as a table: Branch · Folder', !!(await lib.until(async () => (await mergedDialog.locator('.unused-merged-table').count()) === 1, HUNG_MS)) && (await mergedDialog.locator('.unused-merged-table thead th').allInnerTexts()).slice(0, 2).join('|') === 'BRANCH|FOLDER' && (await mergedDialog.locator('.unused-merged-table .short-path[data-path]').getAttribute('data-path')).toLowerCase() === merged.worktree.path.toLowerCase(), await mergedDialog.innerText().catch(() => ''))
  // A long branch is cut in its cell: its full name is on hover (title), and the cell's text is the whole name (copy, screen readers).
  const branchCell = mergedDialog.locator('.unused-merged-table tbody td:first-child strong')
  check('…each branch whole on hover and in its text, however its cell cuts it', (await branchCell.getAttribute('title')) === merged.worktree.branch && (await branchCell.textContent()) === merged.worktree.branch, JSON.stringify({ title: await branchCell.getAttribute('title'), text: await branchCell.textContent(), branch: merged.worktree.branch }))
  await shot('remove-merged-dark')
  await theme('light')
  await shot('remove-merged-light')
  await theme('dark')
  await mergedDialog.getByRole('button', { name: 'Cancel' }).click()
  await lib.until(async () => (await mergedDialog.count()) === 0, HUNG_MS)

  // --- Open the unmerged one: its changes since it left main, and Merge (#400).
  await aheadRow.getByRole('button', { name: 'Open' }).click()
  const fileRow = page.locator('.split-list .row', { hasText: 'work.txt' })
  check('Open shows its changes like an agent worktree\'s (work.txt), since it left main', !!(await lib.until(async () => (await fileRow.count()) === 1, 10000)) && (await page.locator('.split-list').innerText()).includes(`since it left ${main}`), await page.locator('.split-list').innerText().catch(() => ''))
  check('…the picker names it', (await picker.inputValue()).toLowerCase() === `unused:${ahead.worktree.path}`.toLowerCase())
  await page.locator('.split-list .pane-header [aria-label^="Merge"]').click()
  const mergeDialog = page.locator('.dialog', { hasText: `Merge ${ahead.worktree.branch}` })
  check('…its Merge opens the Merge dialog on it', !!(await lib.until(async () => (await mergeDialog.count()) === 1 && /Merges\s+1 commit\s+from/.test(await mergeDialog.innerText()), 8000)), await page.locator('.dialog').last().innerText().catch(() => ''))
  check('…offering to remove it afterwards (not "and the agent", nor moving its branch)', (await mergeDialog.innerText()).includes('Remove the worktree and branch afterwards') && !(await mergeDialog.innerText()).includes('and the agent'))
  await shot('changes-merge-dark')
  await theme('light')
  await shot('changes-merge-light')
  await theme('dark')
  await mergeDialog.getByRole('button', { name: 'Cancel' }).click()
  await lib.until(async () => (await mergeDialog.count()) === 0, HUNG_MS)
  await shot('changes-open-dark')
  await theme('light')
  await shot('changes-open-light')
  await theme('dark')

  // --- The Overview: one line, linking to Changes.
  await page.locator('.tab', { hasText: 'Overview' }).click()
  const line = page.locator('.unused-worktrees-line')
  check('the Overview shows one line: "2 unused worktrees (1 merged) — Review in Changes"', !!(await lib.until(async () => (await line.count()) === 1, 8000)) && /2 unused worktrees \(1 merged\)\s*—\s*Review in Changes/.test(await line.innerText()) && (await page.locator('.unused-wt').count()) === 0, await line.innerText().catch(() => ''))
  await shot('overview-line-dark')
  await theme('light')
  await shot('overview-line-light')
  await theme('dark')
  await line.getByText('Review in Changes').click()
  check('…which opens Changes at the list', !!(await lib.until(async () => (await section.count()) === 1, 8000)))

  // --- Changes' project folder: the notice, only while one holds work.
  await picker.selectOption('')
  const notice = page.locator('.unused-work-notice')
  check('Changes says an unused worktree has work not on main', !!(await lib.until(async () => (await notice.count()) === 1, 8000)) && (await notice.innerText()).includes(`1 unused worktree has work that isn't on ${main}`), await notice.innerText().catch(() => ''))
  await shot('changes')
  await notice.getByText('Review').click()
  check('…its Review goes to the list', !!(await lib.until(async () => (await section.count()) === 1, 8000)))

  // --- Storage: a line for them.
  const st = await inv('storage:project', repo, true)
  check('Storage counts them', (st.unusedWorktrees ?? []).length === 2 && st.unusedWorktrees.every((w) => w.bytes > 0), JSON.stringify(st.unusedWorktrees))

  // --- The Assistant's view: counts, no way to remove.
  const api = await inv('api:info')
  const status = await fetch(`${api.url}/v1/projects/repo`, { headers: { Authorization: `Bearer ${api.token}` } }).then((r) => r.json())
  check('project status counts them for the Assistant', JSON.stringify(status.unusedWorktrees) === JSON.stringify({ count: 2, merged: 1 }), JSON.stringify(status.unusedWorktrees))

  // --- Remove the merged one: folder and branch.
  await mergedRow.getByRole('button', { name: 'Remove', exact: true }).click()
  check('Remove deletes the merged one and its branch', !!(await lib.until(async () => (await mergedRow.count()) === 0 && !fs.existsSync(merged.worktree.path), 10000)) && !branches().includes(merged.worktree.branch), JSON.stringify(branches()))

  // --- The unmerged one: plain removal refused; Remove anyway….
  const refused = await inv('worktrees:removeUnused', repo, ahead.worktree.path, {})
  check('a plain removal of the unmerged one is refused', refused.deleted === false && /1 commit not merged/.test(refused.reason ?? '') && fs.existsSync(ahead.worktree.path), JSON.stringify(refused))
  await shot('holds-work')
  await aheadRow.getByRole('button', { name: 'Remove anyway…' }).click()
  const danger = page.locator('.dialog', { hasText: 'Remove the worktree anyway?' })
  await lib.until(async () => (await danger.count()) === 1, 5000)
  check('Remove anyway… names what goes', (await danger.innerText()).includes(`1 commit on ${ahead.worktree.branch} not on ${main}`), await danger.innerText())
  await shot('anyway')
  // Changed while the question is open: confirming removes nothing; the question closes, Combwork checks again and asks
  // afresh with what it holds now (#377), never a Try Again with the spent check.
  fs.writeFileSync(path.join(ahead.worktree.path, 'later.txt'), 'written after the question')
  await danger.getByRole('button', { name: 'Remove Anyway' }).click()
  const again = page.locator('.dialog', { hasText: 'Checked again: remove it anyway?' })
  check('a worktree changed while the question was open is kept, and asked about again as it is now', !!(await lib.until(async () => (await again.count()) === 1, 8000)) && /Nothing was removed: it changed since you were shown/.test(await again.innerText()) && (await again.innerText()).includes('1 uncommitted file') && fs.existsSync(path.join(ahead.worktree.path, 'later.txt')), await page.locator('.dialog').last().innerText().catch(() => ''))
  check('…no Try Again', (await page.getByRole('button', { name: 'Try Again' }).count()) === 0)
  await shot('again-dark')
  await theme('light')
  await shot('again-light')
  await theme('dark')
  // Left open past 15 minutes (main's clock moved on in this test copy only): refused, then checked and asked again.
  await app.evaluate(() => {
    const real = Date.now.bind(Date)
    globalThis.__realNow = real
    Date.now = () => real() + 16 * 60_000
  })
  await again.getByRole('button', { name: 'Remove Anyway' }).click()
  const expired = page.locator('.dialog', { hasText: 'more than 15 minutes ago' })
  check('a question left open past 15 minutes removes nothing, and asks again with a new check', !!(await lib.until(async () => (await expired.count()) === 1, 8000)) && fs.existsSync(ahead.worktree.path), await page.locator('.dialog').last().innerText().catch(() => ''))
  await app.evaluate(() => {
    Date.now = globalThis.__realNow
  })
  await expired.getByRole('button', { name: 'Remove Anyway' }).click()
  check('…and removes it, branch too (the branch goes just after the folder)', !!(await lib.until(async () => !fs.existsSync(ahead.worktree.path) && !branches().includes(ahead.worktree.branch), 10000)), JSON.stringify([fs.existsSync(ahead.worktree.path), branches(), (await page.locator('.toast').allInnerTexts()).join(' | ')]))
  check('the list goes with the last of them (the page says there are none, #476)', !!(await lib.until(async () => (await section.locator('.unused-wt').count()) === 0 && /no unused worktrees/.test(await section.innerText().catch(() => '')), 8000)), await section.innerText().catch(() => ''))
  // The tab loads its list first; the notice would be there by then.
  await lib.until(async () => (await page.locator('.split-list .pane-header', { hasText: 'Changes' }).count()) === 1, 8000)
  await lib.sleep(500)
  check('…and the Changes notice', (await notice.count()) === 0)

  // Claudette removed keeping its worktree: the unused one the steps below use.
  await inv('agents:remove', repo, claudette.id, { deleteWorktree: false })
  await app.close()

  // --- Without git: nothing is removed.
  ;({ app, page, inv } = await lib.launch({ userData, env: { PATH: pathWithoutGit() } }))
  await lib.openWorkspace(inv, page, ws)
  const nogit = await inv('worktrees:unused', repo)
  check('without git, the list says why instead', nogit.worktrees.length === 0 && /Git isn't installed/.test(nogit.gitProblem ?? ''), JSON.stringify(nogit))
  const kept = await inv('worktrees:removeUnused', repo, claudette.worktree.path, {})
  const preview = await inv('worktrees:removalPreview', repo, claudette.worktree.path).then(() => 'offered', (e) => String(e?.message ?? e))
  const keptAnyway = await inv('worktrees:removeUnused', repo, claudette.worktree.path, { force: 'any-token' })
  check('…and nothing is removed, Remove or Remove anyway (nothing to confirm without git)', !kept.deleted && !keptAnyway.deleted && /isn't installed/.test(preview) && fs.existsSync(claudette.worktree.path), JSON.stringify([kept, keptAnyway, preview]))
  await app.close()

  // --- Merging an unused worktree from Changes (#400): its work lands on main, and it goes after (asked to).
  fs.writeFileSync(path.join(claudette.worktree.path, 'claudette.txt'), 'kept work\n')
  lib.git(claudette.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
  lib.git(claudette.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Claudette kept work'])
  ;({ app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } }))
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('repo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Version Control' }).click()
  const picker2 = page.locator('.split-list .root-select')
  await lib.until(async () => (await picker2.locator(`option[value="unused:${claudette.worktree.path.replace(/\\/g, '\\\\')}"]`).count()) === 1, 10000)
  await picker2.selectOption(`unused:${claudette.worktree.path}`)
  await lib.until(async () => (await page.locator('.split-list .row', { hasText: 'claudette.txt' }).count()) === 1, 10000)
  await page.locator('.split-list .pane-header [aria-label^="Merge"]').click()
  const merging = page.locator('.dialog', { hasText: `Merge ${claudette.worktree.branch}` })
  await lib.until(async () => (await merging.count()) === 1 && /Merges/.test(await merging.innerText()), 8000)
  await merging.locator('label', { hasText: 'Remove the worktree and branch afterwards' }).locator('input').check()
  await merging.getByRole('button', { name: 'Merge', exact: true }).click()
  const onMain = () => lib.git(repo, ['log', '--format=%s', main]).includes('Claudette kept work') || fs.existsSync(path.join(repo, 'claudette.txt'))
  check('Merge brings its work onto main', !!(await lib.until(async () => onMain(), 15000)), lib.git(repo, ['log', '--oneline', '-5']))
  check('…and removes its folder and branch afterwards', !!(await lib.until(async () => !fs.existsSync(claudette.worktree.path) && !branches().includes(claudette.worktree.branch), 10000)), JSON.stringify([fs.existsSync(claudette.worktree.path), branches()]))
  check('…and the picker no longer lists it', !!(await lib.until(async () => (await picker2.locator(`option[value="unused:${claudette.worktree.path.replace(/\\/g, '\\\\')}"]`).count()) === 0, 8000)))
  await app.close()

  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
