// A card's work in the window (#1224): a card a fake Claude Code builder takes through Doing → Review, and its reviewer
// passes, shows its Work section in the card dialog (its branch, base and folder; the revision submitted, round 1, by the
// builder, its file, which opens in Files; the reviewer's pass) and its badges on the board card (the revision, the
// verdict); a card of a project with no version control shows its work with no branch; a card from before 1.0 says it has
// no work record. What couldn't be read, and a card sent to Review with no agent (nothing read before the change), in the
// window's own words, in English and German (#1477). Screenshots of the section (Git and None, both themes, narrow; the
// unread ones in English and German) and the badges. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): it starts this checkout's Electron itself, and Tree is a 0.9 worktree agent
// (agents:testLegacy).
const lib = require('./lib.cjs')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
const { _electron } = require('playwright-core')
const { DatabaseSync } = require('node:sqlite')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'cardwork-profile')
const ws = path.join(lib.WORK, 'cardwork-ws')
const claudeHome = path.join(lib.WORK, 'cardwork-claude-home')
const alpha = path.join(ws, 'alpha')
const notes = path.join(ws, 'notes')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const commit = (dir, file, text, message) => {
  fs.writeFileSync(path.join(dir, file), text)
  lib.git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', file])
  lib.git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message])
  return lib.git(dir, ['rev-parse', 'HEAD']).trim()
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  // A project with no version control: None.
  fs.mkdirSync(notes, { recursive: true })
  fs.writeFileSync(path.join(notes, 'plan.md'), '# Plan\n')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })

  let app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  let page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  let inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await inv('project:setActive', notes, true)
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const idle = async (p, id) => ['ready', 'finished'].includes((await live(p, id))?.status)
  const say = async (p, id, text) => {
    await lib.until(() => idle(p, id), HUNG_MS)
    // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(p, id), claudeHome, null, text, { live: () => live(p, id) })
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const writer = await lib.addAgent(inv, notes, { name: 'Writer' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase(), notes.toLowerCase()]))
  for (const [p, a] of [[alpha, builder], [alpha, reviewer], [notes, writer]]) await inv('session:start', p, { agentId: a.id })
  check('the agents start', !!(await lib.until(async () => (await idle(alpha, builder.id)) && (await idle(alpha, reviewer.id)) && (await idle(notes, writer.id)), HUNG_MS)))

  // --- A Git card: Doing, a commit, Review, passed.
  const g = (await inv('tasks:create', { title: 'Greeting says Hi', project: 'alpha', agent: builder.id, column: 'todo' })).number
  await say(alpha, builder.id, `boardmove ${g} doing`)
  check('the builder takes the card', !!(await lib.until(async () => (await card(g))?.column === 'doing', HUNG_MS)))
  const base = lib.git(alpha, ['rev-parse', 'HEAD']).trim()
  const rev = commit(alpha, 'greet.ts', 'export const greet = () => "Hi"\n', 'Greeting says Hi')
  await say(alpha, builder.id, `boardmove ${g} review`)
  check('…and sends it to Review', !!(await lib.until(async () => (await card(g))?.column === 'review', HUNG_MS)))
  await say(alpha, reviewer.id, `boardreview ${g} start`)
  await lib.until(async () => (await card(g))?.review?.agent === reviewer.id, HUNG_MS)
  await say(alpha, reviewer.id, `boardreview ${g} passed passed`)
  check('the reviewer passes it', !!(await lib.until(async () => (await card(g))?.column === 'passed', HUNG_MS)))

  // Its work, as the window reads it.
  const work = await lib.until(async () => { const v = await inv('tasks:work', g); return v && v.revisions.length === 1 && v.verdicts.length === 1 && v }, HUNG_MS)
  check('its work records the revision submitted and the pass', work?.revisions[0]?.revision === rev && work?.verdicts[0]?.pass === true, JSON.stringify(work && { revisions: work.revisions, verdicts: work.verdicts }))

  // --- Its badges on the board.
  await showBoard(page)
  const tile = page.locator(`.task-card[data-task="${g}"]`)
  const badges = tile.locator('.task-work')
  check('the board card shows its revision and its verdict, each with an accessible name', !!(await lib.until(async () => (await badges.locator('code').innerText().catch(() => '')) === rev.slice(0, 7) && (await badges.locator('[aria-label^="Revision: "]').count()) === 1 && (await badges.locator('[aria-label^="Last verdict: passed"]').count()) === 1, HUNG_MS)), await badges.innerHTML().catch(() => ''))
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await tile.screenshot({ path: path.join(lib.WORK, `cardwork-badges-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // --- The Work section in the card dialog.
  await tile.click()
  const dialog = lib.cardDialog(page, await lib.cardLabel(inv, g))
  await dialog.waitFor({ timeout: HUNG_MS })
  const section = dialog.locator('.card-work[data-work="recorded"]')
  await section.waitFor({ timeout: HUNG_MS })
  const text = async () => (await section.innerText().catch(() => '')).replace(/\s+/g, ' ')
  const wants = ['Branch', 'Base', base.slice(0, 7), 'Folder', 'The project folder', 'Revisions, newest first', rev.slice(0, 7), 'Round 1', 'Builder', '1 file changed', 'Reviewer: passed']
  check('the Work section: its branch, base and folder; the revision, its round, builder and file; the pass', !!(await lib.until(async () => { const t = await text(); return wants.every((w) => t.includes(w)) }, HUNG_MS)), await (async () => { const t = await text(); return `${t} [missing: ${wants.filter((w) => !t.includes(w)).join(', ')}]` })())
  await section.locator('.card-work-rev').first().getByRole('button', { name: '1 file changed' }).click()
  const file = section.locator('.card-work-files button', { hasText: 'greet.ts' })
  check('its files show on a click', !!(await lib.until(async () => (await file.count()) === 1, HUNG_MS)))
  await section.scrollIntoViewIfNeeded()
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await section.screenshot({ path: path.join(lib.WORK, `cardwork-git-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  // Narrow: the section keeps inside the dialog.
  await lib.fitWindow(app, page, { width: 820, height: 950 })
  const fits = await lib.until(async () => section.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), HUNG_MS)
  check('narrow, the section fits the dialog', !!fits)
  await section.screenshot({ path: path.join(lib.WORK, 'cardwork-git-narrow.png') })
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await file.click()
  check('a file opens in the project’s Files tab', !!(await lib.until(async () => (await page.locator('.tab-body').innerText().catch(() => '')).includes('greet.ts'), HUNG_MS)))

  const closeDialogs = () =>
    lib.until(async () => {
      if (await page.locator('.dialog').count()) await page.keyboard.press('Escape')
      return (await page.locator('.dialog').count()) === 0
    }, HUNG_MS)
  const openCard = async (n) => {
    await closeDialogs()
    await showBoard(page)
    await openByTitle(page, n)
    const d = lib.cardDialog(page, await lib.cardLabel(inv, n))
    await d.waitFor({ timeout: HUNG_MS })
    return d
  }

  // --- A submission whose repository couldn't be read (#1224 round 1, finding 2): its revision and files say they
  // weren't read, and why, never "no files changed". HEAD is unreadable while it is submitted, then put back.
  const u = (await inv('tasks:create', { title: 'Read failure', project: 'alpha', agent: builder.id, column: 'todo' })).number
  await say(alpha, builder.id, `boardmove ${u} doing`)
  await lib.until(async () => (await card(u))?.column === 'doing', HUNG_MS)
  const headFile = path.join(alpha, '.git', 'HEAD')
  const headWas = fs.readFileSync(headFile, 'utf8')
  fs.writeFileSync(headFile, 'not a ref\n')
  try {
    await say(alpha, builder.id, `boardmove ${u} review`)
    check('a card is submitted while its repository can’t be read', !!(await lib.until(async () => (await card(u))?.column === 'review', HUNG_MS)))
  } finally {
    fs.writeFileSync(headFile, headWas)
  }
  const uWork = await lib.until(async () => { const v = await inv('tasks:work', u); return v?.revisions.length === 1 && v }, HUNG_MS)
  check('its work keeps what couldn’t be read, and why', !!uWork?.revisions[0]?.unknown?.revision && !!uWork.revisions[0].unknown.files, JSON.stringify(uWork?.revisions[0]))
  const uSection = (await openCard(u)).locator('.card-work[data-work="recorded"]')
  const uText = async () => (await uSection.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('the Work section says the revision and its files weren’t read, with why, not that none changed', !!(await lib.until(async () => { const t = await uText(); return t.includes('Revision not read when it was submitted: ') && t.includes('Its next submission reads it again.') && t.includes('Files not read: ') && !t.includes('No files changed') }, HUNG_MS)), await uText())
  // Why, as the window words it (#1477): what couldn't be read, from the reason kept as data, said once.
  check('…the revision line names what couldn’t be read once', !!(await lib.until(async () => /Revision not read when it was submitted: Combwork couldn't read the latest commit in [^ ]+\. Its next submission reads it again\./.test(await uText()), HUNG_MS)), await uText())
  await uSection.scrollIntoViewIfNeeded()
  const shots = async (loc, name) => {
    await page.mouse.move(5, 5)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await loc.screenshot({ path: path.join(lib.WORK, `cardwork-${name}-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  await shots(uSection, 'unread')

  // --- A card that went into Review with no agent (#1477): nothing was read before the change, which the window says
  // in a sentence of its own, never with the English note agents read ("not read before the change").
  const nobody = (await inv('tasks:create', { title: 'Nobody built it', project: 'alpha', column: 'review' })).number
  const nWork = await lib.until(async () => { const v = await inv('tasks:work', nobody); return v?.revisions.length === 1 && v }, HUNG_MS)
  check('its work records the revision as not read before the change, in English for agents', nWork?.revisions[0]?.unknown?.revision === 'not read before the change', JSON.stringify(nWork?.revisions[0]))
  const nSection = (await openCard(nobody)).locator('.card-work[data-work="recorded"]')
  const nText = async () => (await nSection.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('the Work section says no revision was recorded, and why, once', !!(await lib.until(async () => { const t = await nText(); return t.includes("No revision recorded: Combwork didn't read one when the card went to Review. Its next submission reads it again.") && t.includes('Files not read') && !t.includes('not read before the change') }, HUNG_MS)), await nText())
  await nSection.scrollIntoViewIfNeeded()
  await shots(nSection, 'notread')

  // --- The same in German: no English inside its sentences.
  const base0 = (await inv('app:info')).language
  const deDir = path.join(lib.ROOT, 'locales', 'de')
  const deMessages = Object.assign({}, ...fs.readdirSync(deDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(deDir, f), 'utf8'))))
  const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
  await speak({ ...base0, code: 'de', locale: 'de', messages: deMessages })
  const english = /not read|latest commit|no base|no target|Its next submission/
  check('German: nothing read before the change, said in German', !!(await lib.until(async () => { const t = await nText(); return t.includes('Keine Revision aufgezeichnet: Combwork hat keine gelesen, als die Karte nach Review kam.') && t.includes('Dateien nicht gelesen') && !english.test(t) }, HUNG_MS)), await nText())
  await shots(nSection, 'notread-de')
  // The board's button has its English name again before the next card opens; then German with its dialog open.
  await speak(base0)
  await lib.until(async () => (await page.getByRole('button', { name: 'Task Board' }).count()) > 0, HUNG_MS)
  const uDe = (await openCard(u)).locator('.card-work[data-work="recorded"]')
  await speak({ ...base0, code: 'de', locale: 'de', messages: deMessages })
  const uDeText = async () => (await uDe.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('German: what couldn’t be read, in German too', !!(await lib.until(async () => { const t = await uDeText(); return t.includes('Revision beim Einreichen nicht gelesen: Combwork konnte den neuesten Commit in ') && !english.test(t) }, HUNG_MS)), await uDeText())
  await uDe.scrollIntoViewIfNeeded()
  await shots(uDe, 'unread-de')
  await speak(base0)
  await lib.until(async () => (await page.getByRole('button', { name: 'Task Board' }).count()) > 0, HUNG_MS)
  await closeDialogs()

  // --- A builder in its own worktree: its files open there (#1224 round 1, finding 1); once no agent has that folder,
  // its files are shown as text with why, never opened in another tree.
  const tree = await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  const treePath = (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase()).agents.find((a) => a.id === tree.id).worktree.path
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase(), notes.toLowerCase(), treePath.toLowerCase()]))
  await inv('session:start', alpha, { agentId: tree.id })
  await lib.until(() => idle(alpha, tree.id), HUNG_MS)
  const treeCard = (await inv('tasks:create', { title: 'In its own folder', project: 'alpha', agent: tree.id, column: 'todo' })).number
  await say(alpha, tree.id, `boardmove ${treeCard} doing`)
  await lib.until(async () => (await card(treeCard))?.column === 'doing', HUNG_MS)
  commit(treePath, 'tree-only.ts', 'export const tree = true\n', 'Tree work')
  await say(alpha, tree.id, `boardmove ${treeCard} review`)
  check('the worktree builder submits its card', !!(await lib.until(async () => (await card(treeCard))?.column === 'review', HUNG_MS)))
  let tDialog = await openCard(treeCard)
  let tSection = tDialog.locator('.card-work[data-work="recorded"]')
  check('its folder is the worktree’s', !!(await lib.until(async () => (await tSection.innerText().catch(() => '')).toLowerCase().includes(treePath.toLowerCase().replace(/\\/g, '/')) || (await tSection.innerText().catch(() => '')).toLowerCase().includes(treePath.toLowerCase()), HUNG_MS)), await tSection.innerText().catch(() => ''))
  await tSection.getByRole('button', { name: '1 file changed' }).click()
  await tSection.locator('.card-work-files button', { hasText: 'tree-only.ts' }).click()
  // The file is only in the worktree: the Files tab shows it there.
  check('a file opens in the worktree it was made in', !!(await lib.until(async () => (await page.locator('.tab-body').innerText().catch(() => '')).includes('tree-only.ts'), HUNG_MS)))
  await inv('session:stop', alpha, tree.id)
  await lib.until(async () => !(await live(alpha, tree.id)), HUNG_MS)
  await inv('agents:remove', alpha, tree.id, { deleteWorktree: false, releaseCards: false })
  tDialog = await openCard(treeCard)
  tSection = tDialog.locator('.card-work[data-work="recorded"]')
  await lib.until(async () => (await tSection.count()) === 1, HUNG_MS)
  await tSection.getByRole('button', { name: '1 file changed' }).click()
  check('once no agent has its folder, its files show as text, saying why', !!(await lib.until(async () => (await tSection.locator('.card-work-files button').count()) === 0 && (await tSection.locator('.card-work-files').innerText().catch(() => '')).includes('tree-only.ts') && (await tSection.locator('.card-work-gone').innerText().catch(() => '')).includes('is no longer an agent’s worktree'), HUNG_MS)), await tSection.innerText().catch(() => ''))
  await closeDialogs()

  // --- A None card: no branch, its work in the project folder.
  const nn = (await inv('tasks:create', { title: 'Write the plan', project: 'notes', agent: writer.id, column: 'todo' })).number
  await say(notes, writer.id, `boardmove ${nn} doing`)
  await lib.until(async () => (await card(nn))?.column === 'doing', HUNG_MS)
  fs.writeFileSync(path.join(notes, 'plan.md'), '# Plan\n\nShip it.\n')
  await say(notes, writer.id, `boardmove ${nn} review`)
  check('the None card goes to Review', !!(await lib.until(async () => (await card(nn))?.column === 'review', HUNG_MS)))
  // The first card's dialog, if opening its file left it open, is closed first.
  await lib.until(async () => {
    if (await page.locator('.dialog').count()) await page.keyboard.press('Escape')
    return (await page.locator('.dialog').count()) === 0
  }, HUNG_MS)
  await showBoard(page)
  await openByTitle(page, nn)
  const noneDialog = lib.cardDialog(page, await lib.cardLabel(inv, nn))
  await noneDialog.waitFor({ timeout: HUNG_MS })
  const noneSection = noneDialog.locator('.card-work[data-work="recorded"]')
  const noneText = async () => (await noneSection.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('a None card’s Work section: no branch, its folder, and no revision read yet (P3 reads Git’s only)', !!(await lib.until(async () => { const t = await noneText(); return t.includes('The project folder') && t.includes('Round 1') && t.includes('No revision recorded') && !t.includes('Branch') }, HUNG_MS)), await noneText())
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await noneSection.screenshot({ path: path.join(lib.WORK, `cardwork-none-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.keyboard.press('Escape')

  // --- A card from before 1.0: no work record. Marked so in the closed board, as the upgrade marks one.
  const old = (await inv('tasks:create', { title: 'An old card', project: 'alpha', column: 'todo' })).number
  for (const p of [alpha, notes]) await inv('session:stop', p)
  await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  await app.close()
  const db = new DatabaseSync(path.join(ws, '.combwork', 'hive.db'), { timeout: 5000 })
  db.prepare('UPDATE cards SET pre_workflow = 1 WHERE number = ?').run(old)
  db.close()
  app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    page = await app.firstWindow()
    await lib.fitWindow(app, page, { width: 1500, height: 950 })
    await lib.appReady(page)
    inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.until(async () => (await inv('workspace:get'))?.path?.toLowerCase() === ws.toLowerCase(), HUNG_MS)
    await showBoard(page)
    await openByTitle(page, old)
    const oldSection = lib.cardDialog(page, await lib.cardLabel(inv, old)).locator('.card-work[data-work="before-1.0"]')
    check('a card from before 1.0 says it has no work record', !!(await lib.until(async () => (await oldSection.innerText().catch(() => '')).includes('Before 1.0: this card has no work record.'), HUNG_MS)), await oldSection.innerText().catch(() => ''))
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
