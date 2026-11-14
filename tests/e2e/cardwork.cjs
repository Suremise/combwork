// A card's work in the window (#1224): a card a fake Claude Code builder takes through Doing → Review, and its reviewer
// passes, shows its Work section in the card dialog (its branch, base and folder; the revision submitted, round 1, by the
// builder, its file, which opens in Files; its own diff from base to revision, read from the commits (HI-3218); the
// reviewer's pass) and its badges on the board card (the revision, the
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
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })

  let app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  let page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  let inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
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
  // Each read of a fake's input logged (HI-3220: a builder's doorbell seen typed), before they start.
  lib.logFakeInput(claudeHome)
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

  // --- HI-3218: the revision's own diff, base to revision, from the commits (the working tree moves on meanwhile).
  const sub = work.revisions[0].submission
  fs.writeFileSync(path.join(alpha, 'greet.ts'), 'export const greet = () => "uncommitted"\n')
  const read = await inv('tasks:revisionDiff', g, sub, 'greet.ts').catch((e) => ({ error: String(e?.message ?? e) }))
  check('its diff is read from the commits: added at the revision, never the working tree', read?.original === '' && read?.modified === 'export const greet = () => "Hi"\n' && read?.binary === false, JSON.stringify(read))
  const notListed = await inv('tasks:revisionDiff', g, sub, 'package.json').then(() => null, (e) => String(e?.message ?? e))
  check('a file the submission doesn’t list is refused', /isn't one of this submission's files/.test(notListed ?? ''), String(notListed))
  const rev0 = section.locator('.card-work-rev').first()
  await rev0.getByRole('button', { name: 'Changes' }).click()
  const changes = rev0.locator(`[data-revision-changes="${sub}"]`)
  const shown = rev0.locator('[data-revision-diff="greet.ts"] .monaco')
  check('Changes shows the revision’s file and its diff, base to revision', !!(await lib.until(async () => (await changes.locator('[data-revision-file="greet.ts"][aria-current="true"]').count()) === 1 && (await shown.innerText().catch(() => '')).includes('"Hi"') && (await changes.innerText().catch(() => '')).includes(`${base.slice(0, 7)} ↔ ${rev.slice(0, 7)}`), HUNG_MS)), await changes.innerText().catch(() => ''))
  // Through the setting (HR1's round 1): the editor's theme follows it, not the page's attribute alone. Each shot once the
  // editor shows that theme (Monaco's own class: vs-dark or vs).
  const editorClass = () => shown.evaluate((e) => e.querySelector('.monaco-editor')?.className ?? '').catch(() => '')
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    const editorIn = await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme && /\bvs-dark\b/.test(await editorClass()) === (theme === 'dark') && /\bvs(-dark)?\b/.test(await editorClass()), HUNG_MS)
    check(`the diff shows in the ${theme} theme`, !!editorIn, await editorClass())
    await changes.screenshot({ path: path.join(lib.WORK, `cardwork-changes-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', HUNG_MS)

  // --- HI-3219: a line comment on the revision's diff: added with the glyph margin's +, edited, resolved, reopened, deleted.
  const comments = async () => (await inv('tasks:work', g))?.lineComments ?? []
  const modifiedLine = rev0.locator('[data-revision-diff="greet.ts"] .editor.modified .view-line').first()
  await modifiedLine.hover()
  const plus = rev0.locator('[data-revision-diff="greet.ts"] .editor.modified .cw-comment-add')
  check('hovering a line shows the + to comment on it', !!(await lib.until(async () => (await plus.count()) === 1, HUNG_MS)))
  await plus.click()
  const composer = rev0.locator('[data-comment-composer]')
  check('pressing it opens a comment box under the line', !!(await lib.until(async () => (await composer.count()) === 1, HUNG_MS)))
  await composer.locator('textarea').fill('Say **Hello**, not Hi.')
  await composer.locator('textarea').press('Control+Enter')
  const one = await lib.until(async () => { const c = await comments(); return c.length === 1 && c[0] }, HUNG_MS)
  check('Ctrl+Enter saves it on the card: its side, line and the quote read from the commit', one?.side === 'new' && one.from === 1 && one.to === 1 && one.lines === 'export const greet = () => "Hi"' && one.body === 'Say **Hello**, not Hi.' && one.state === 'open' && one.version === 1 && /^lc-.+-\d+$/.test(one.id), JSON.stringify(one))
  const thread = rev0.locator(`[data-line-comment="${one?.id}"]`)
  check('it shows under its line, in Markdown, with the revision’s and the file’s open counts', !!(await lib.until(async () => (await thread.locator('.cw-comment-body strong').innerText().catch(() => '')) === 'Hello' && (await composer.count()) === 0 && (await section.locator('[data-revision-open-comments="1"]').count()) === 1 && (await rev0.locator('[data-file-comments="greet.ts"]').innerText().catch(() => '')) === '1 open comment', HUNG_MS)), await rev0.innerText().catch(() => ''))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme && /\bvs-dark\b/.test(await editorClass()) === (theme === 'dark'), HUNG_MS)
    await changes.screenshot({ path: path.join(lib.WORK, `cardwork-comment-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await thread.getByRole('button', { name: 'Edit' }).click()
  await thread.locator('textarea').fill('Say Hello.')
  await thread.locator('textarea').press('Control+Enter')
  check('Edit changes its text and raises its version', !!(await lib.until(async () => { const c = (await comments())[0]; return c?.body === 'Say Hello.' && c.version === 2 }, HUNG_MS)), JSON.stringify(await comments()))
  const stale = await inv('tasks:lineCommentChange', g, one.id, { edit: { body: 'Old view', version: 1 } }).then(() => null, (e) => String(e?.message ?? e))
  check('an edit from an older version is refused', /changed meanwhile/.test(stale ?? ''), String(stale))
  // HR1's round 1: an editor left open while the comment changes elsewhere saves against the version it opened on, so its
  // stale draft is refused, never written over the newer text.
  await thread.getByRole('button', { name: 'Edit' }).click()
  await thread.locator('textarea').fill('A stale draft.')
  await inv('tasks:lineCommentChange', g, one.id, { edit: { body: 'Newer, from elsewhere.', version: 2 } })
  check('the comment changes elsewhere while its editor is open, and its thread in the window has version 3', !!(await lib.until(async () => { const c = (await comments())[0]; return c?.version === 3 && c.body === 'Newer, from elsewhere.' && (await thread.getAttribute('data-version').catch(() => '')) === '3' && (await thread.locator('textarea').count()) === 1 && (await thread.locator('textarea').inputValue().catch(() => '')) === 'A stale draft.' }, HUNG_MS)), JSON.stringify(await comments()))
  await thread.locator('textarea').press('Control+Enter')
  check('saving the stale draft is refused, saying so, and the newer text stays', !!(await lib.until(async () => /changed meanwhile/.test(await thread.innerText().catch(() => '')), HUNG_MS)) && (await comments())[0]?.body === 'Newer, from elsewhere.' && (await comments())[0]?.version === 3, `${await thread.innerText().catch(() => '')} | ${JSON.stringify(await comments())}`)
  await thread.getByRole('button', { name: 'Cancel' }).click()
  await thread.getByRole('button', { name: 'Resolve' }).click()
  check('Resolve marks it resolved, and it no longer counts as open', !!(await lib.until(async () => (await comments())[0]?.state === 'resolved' && (await section.locator('[data-revision-open-comments]').count()) === 0 && (await thread.getAttribute('data-state').catch(() => '')) === 'resolved', HUNG_MS)))
  await thread.getByRole('button', { name: 'Reopen' }).click()
  check('Reopen opens it again', !!(await lib.until(async () => (await comments())[0]?.state === 'open', HUNG_MS)))
  await thread.getByRole('button', { name: 'Delete' }).click()
  check('Delete takes back a comment never sent', !!(await lib.until(async () => (await comments()).length === 0 && (await thread.count()) === 0, HUNG_MS)))
  const empty = await inv('tasks:lineCommentAdd', g, { submission: sub, path: 'greet.ts', side: 'new', from: 1, to: 1, body: '   ' }).then(() => null, (e) => String(e?.message ?? e))
  const past = await inv('tasks:lineCommentAdd', g, { submission: sub, path: 'greet.ts', side: 'new', from: 1, to: 9, body: 'x' }).then(() => null, (e) => String(e?.message ?? e))
  check('an empty comment, and lines past the file’s end, are refused', /needs some text/.test(empty ?? '') && /aren’t in that side/.test(past ?? ''), `${empty} | ${past}`)
  await rev0.getByRole('button', { name: 'Changes' }).click()
  check('…and hides on a second click', !!(await lib.until(async () => (await changes.count()) === 0, HUNG_MS)))
  lib.git(alpha, ['checkout', '--', 'greet.ts'])
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

  // --- HI-3220: a card's open comments sent to its builder as one fix round: from Review (the dialog), then from Passed.
  const fb = (await inv('tasks:create', { title: 'Feedback card', project: 'alpha', agent: builder.id, column: 'todo' })).number
  await say(alpha, builder.id, `boardmove ${fb} doing`)
  await lib.until(async () => (await card(fb))?.column === 'doing', HUNG_MS)
  commit(alpha, 'feedback.ts', 'export const answer = 41\n', 'Feedback card')
  await say(alpha, builder.id, `boardmove ${fb} review`)
  check('a card for feedback goes to Review', !!(await lib.until(async () => (await card(fb))?.column === 'review', HUNG_MS)))
  const fbFacts = async () => (await inv('tasks:facts', fb)) ?? []
  const fbSub = (await inv('tasks:work', fb)).revisions.at(-1).submission
  const c1 = await inv('tasks:lineCommentAdd', fb, { submission: fbSub, path: 'feedback.ts', side: 'new', from: 1, to: 1, body: 'The answer is **42**.' })
  const typed = () => (fs.existsSync(path.join(claudeHome, 'fake-input.jsonl')) ? fs.readFileSync(path.join(claudeHome, 'fake-input.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.agent === 'Builder').map((x) => x.data) : [])
  const typedBefore = typed().length
  const fbDialog = await openCard(fb)
  const sendButton = fbDialog.locator('[data-send-feedback]')
  check('in Review, Send 1 comment to Builder is offered', !!(await lib.until(async () => (await sendButton.innerText().catch(() => '')) === 'Send 1 comment to Builder', HUNG_MS)), await fbDialog.locator('.card-work').innerText().catch(() => ''))
  await sendButton.click()
  const preview = page.locator('[data-send-preview]')
  check('its preview lists the comment', !!(await lib.until(async () => (await preview.locator(`[data-send-item="${c1}"]`).count()) === 1, HUNG_MS)))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await page.getByRole('dialog', { name: 'Send comments to Builder' }).screenshot({ path: path.join(lib.WORK, `cardwork-send-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.locator('[data-send-confirm]').click()
  const sentFacts = async (n) => (await fbFacts()).filter((f) => f.kind === 'FeedbackSent').length === n
  check('Send: the user’s failed verdict in round 1 (the card’s latest comment too), FeedbackSent, the card back in Doing', !!(await lib.until(async () => { const f = await fbFacts(); const v = f.filter((x) => x.kind === 'Verdict').at(-1)?.data; return (await sentFacts(1)) && v?.reviewer === 'user' && v.pass === false && v.round === 1 && v.comment.includes(`[${c1}] feedback.ts:1 (new)`) && (await card(fb))?.column === 'doing' && (await card(fb))?.comments.at(-1)?.text === v.comment }, HUNG_MS)), JSON.stringify((await fbFacts()).slice(-4)))
  check('its builder is woken: Combwork types its inbox’s doorbell', !!(await lib.until(() => typed().slice(typedBefore).some((d) => d.includes('[CW]')), HUNG_MS)), JSON.stringify(typed().slice(typedBefore)))
  // Round 2: the builder submits again and the reviewer passes it; the comment, still open, goes again from Passed.
  await closeDialogs()
  commit(alpha, 'feedback.ts', 'export const answer = 42\n', 'The answer')
  await say(alpha, builder.id, `boardmove ${fb} review`)
  await lib.until(async () => (await card(fb))?.column === 'review', HUNG_MS)
  await say(alpha, reviewer.id, `boardreview ${fb} start`)
  await lib.until(async () => (await card(fb))?.review?.agent === reviewer.id, HUNG_MS)
  await say(alpha, reviewer.id, `boardreview ${fb} passed passed`)
  check('round 2 passes', !!(await lib.until(async () => (await card(fb))?.column === 'passed', HUNG_MS)))
  const again = await inv('tasks:feedbackPreview', fb)
  check('the open comment, sent before, is in the next send’s preview', again.items.length === 1 && again.items[0].id === c1 && again.items[0].sent === true && again.items[0].edited === false, JSON.stringify(again.items))
  const fromPassed = await inv('tasks:feedbackSend', fb, { batch: again.batch, items: again.items.map((c) => ({ id: c.id, version: c.version })), expect: again.expect, replaces: null }).then(() => null, (e) => String(e?.message ?? e))
  check('from Passed: sent, round 2 counted, the card back in Doing', fromPassed === null && !!(await lib.until(async () => (await sentFacts(2)) && (await fbFacts()).filter((x) => x.kind === 'Verdict' && x.data.reviewer === 'user').at(-1)?.data.round === 2 && (await card(fb))?.column === 'doing', HUNG_MS)), String(fromPassed))
  const twice = await inv('tasks:feedbackSend', fb, { batch: again.batch, items: again.items.map((c) => ({ id: c.id, version: c.version })), expect: again.expect, replaces: null }).then(() => null, (e) => String(e?.message ?? e))
  // The card is back in Doing: refused by its stage first (Workflow.feedback's checks; a batch sent twice in Review is the unit test's).
  check('the same send again is refused', /Review or Approved only/.test(twice ?? ''), String(twice))

  // --- HI-3239: what is being typed in a thread survives other spots coming and going: a draft opened at another line,
  // and a comment added or deleted there from elsewhere (another window), never remount it (each spot keeps its zone).
  // Its base has the file with line 1 changed by the card, so the diff has an original side (HI-3274's inline flip).
  commit(alpha, 'lines.ts', 'export const one = 0\nexport const two = 2\nexport const three = 3\n', 'Lines before')
  const kt = (await inv('tasks:create', { title: 'Keep typing', project: 'alpha', agent: builder.id, column: 'todo' })).number
  await say(alpha, builder.id, `boardmove ${kt} doing`)
  await lib.until(async () => (await card(kt))?.column === 'doing', HUNG_MS)
  commit(alpha, 'lines.ts', 'export const one = 1\nexport const two = 2\nexport const three = 3\n', 'Keep typing')
  await say(alpha, builder.id, `boardmove ${kt} review`)
  await lib.until(async () => (await card(kt))?.column === 'review', HUNG_MS)
  const ktSub = (await inv('tasks:work', kt)).revisions.at(-1).submission
  const k1 = await inv('tasks:lineCommentAdd', kt, { submission: ktSub, path: 'lines.ts', side: 'new', from: 1, to: 1, body: 'On one.' })
  const ktRev = (await openCard(kt)).locator('.card-work[data-work="recorded"] .card-work-rev').first()
  await ktRev.getByRole('button', { name: 'Changes' }).click()
  const k1Thread = ktRev.locator(`[data-line-comment="${k1}"]`)
  check('a card with three lines and a comment on line 1 shows its thread', !!(await lib.until(async () => (await k1Thread.count()) === 1, HUNG_MS)))
  await k1Thread.getByRole('button', { name: 'Edit' }).click()
  const editBox = k1Thread.locator('textarea')
  await editBox.fill('Half-typed edit')
  // Mark the box itself: a remounted one is a new element without the mark.
  await editBox.evaluate((e) => { e.dataset.probe = 'kept' })
  const editKept = async () => (await k1Thread.locator('textarea[data-probe="kept"]').count()) === 1 && (await editBox.inputValue().catch(() => '')) === 'Half-typed edit'
  // Line 3 by its text: Monaco's lines aren't in line order in the page.
  await ktRev.locator('[data-revision-diff="lines.ts"] .editor.modified .view-line', { hasText: 'three' }).hover()
  const ktPlus = ktRev.locator('[data-revision-diff="lines.ts"] .editor.modified .cw-comment-add')
  await lib.until(async () => (await ktPlus.count()) === 1, HUNG_MS)
  await ktPlus.click()
  const ktDraft = ktRev.locator('[data-comment-composer]').filter({ hasText: 'Changed 3' })
  check('a draft opened at line 3 keeps the edit typed at line 1, in the same box', !!(await lib.until(async () => (await ktDraft.count()) === 1, HUNG_MS)) && (await editKept()), `${await editBox.inputValue().catch(() => '(gone)')} | ${await ktRev.innerText().catch(() => '')}`)
  await ktDraft.locator('textarea').fill('Draft at three')
  await ktDraft.locator('textarea').evaluate((e) => { e.dataset.probe = 'kept' })
  const draftKept = async () => (await ktDraft.locator('textarea[data-probe="kept"]').count()) === 1 && (await ktDraft.locator('textarea').inputValue().catch(() => '')) === 'Draft at three'
  // From elsewhere (another window, the Agent API): a comment added at line 2, then deleted.
  const k2 = await inv('tasks:lineCommentAdd', kt, { submission: ktSub, path: 'lines.ts', side: 'new', from: 2, to: 2, body: 'From another window.' })
  check('a comment arriving at line 2 from elsewhere keeps both the edit and the draft', !!(await lib.until(async () => (await ktRev.locator(`[data-line-comment="${k2}"]`).count()) === 1, HUNG_MS)) && (await editKept()) && (await draftKept()), `${await editBox.inputValue().catch(() => '(gone)')} | ${await ktDraft.locator('textarea').inputValue().catch(() => '(gone)')}`)
  // The edit, the comment from elsewhere and the draft, each under its line, in both themes.
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await ktRev.screenshot({ path: path.join(lib.WORK, `cardwork-keep-typing-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  check('…switching the theme keeps them too', (await editKept()) && (await draftKept()))
  await inv('tasks:lineCommentChange', kt, k2, 'delete')
  check('…and so does its deletion', !!(await lib.until(async () => (await ktRev.locator(`[data-line-comment="${k2}"]`).count()) === 0, HUNG_MS)) && (await editKept()) && (await draftKept()), `${await editBox.inputValue().catch(() => '(gone)')} | ${await ktDraft.locator('textarea').inputValue().catch(() => '(gone)')}`)
  // --- HI-3274: a + elsewhere while a draft has text opens another draft beside it, never in its place; an empty draft
  // gives way; and a draft or an edit on the original side keeps its text while the diff shows inline, and back.
  const ktComposers = ktRev.locator('[data-comment-composer]')
  const plusAt = async (side, text) => {
    await ktRev.locator(`[data-revision-diff="lines.ts"] .editor.${side} .view-line`, { hasText: text }).hover()
    const p = ktRev.locator(`[data-revision-diff="lines.ts"] .editor.${side} .cw-comment-add`)
    await lib.until(async () => (await p.count()) === 1, HUNG_MS)
    await p.click()
  }
  await plusAt('modified', 'two')
  const atTwo = ktComposers.filter({ hasText: 'Changed 2' }).filter({ hasNotText: 'Changed 2–3' })
  check('a + at line 2 opens a draft there and keeps the draft typed at line 3, in the same box', !!(await lib.until(async () => (await atTwo.count()) === 1, HUNG_MS)) && (await draftKept()) && (await editKept()), await ktRev.innerText().catch(() => ''))
  // Lines 2–3 selected, then the + on line 3: a draft on the range, ending where the line-3 draft does.
  await ktRev.locator('[data-revision-diff="lines.ts"] .editor.modified .view-line', { hasText: 'two' }).click()
  await page.keyboard.press('Shift+ArrowDown')
  await plusAt('modified', 'three')
  const range = ktComposers.filter({ hasText: 'Changed 2–3' })
  check('a + on lines 2–3 selected opens a draft on them beside the line-3 one, kept; the empty line-2 draft gives way', !!(await lib.until(async () => (await range.count()) === 1 && (await atTwo.count()) === 0, HUNG_MS)) && (await draftKept()) && (await editKept()), await ktRev.innerText().catch(() => ''))
  await range.locator('textarea').fill('On the range')
  await plusAt('modified', 'three')
  check('a + on an open draft’s own line goes back to it: no other box opens', !!(await lib.until(async () => (await ktComposers.count()) === 3, HUNG_MS)) && (await draftKept()) && (await range.locator('textarea').inputValue()) === 'On the range', String(await ktComposers.count()))
  // The original side: a draft at its line 1 ("one = 0"), then the diff inline and back.
  await plusAt('original', 'one')
  const oldDraft = ktRev.locator('[data-comment-composer]').filter({ hasText: 'Original 1' })
  check('a + on the original side opens a draft there', !!(await lib.until(async () => (await oldDraft.count()) === 1, HUNG_MS)))
  await oldDraft.locator('textarea').fill('Old side draft')
  const inlineButton = ktRev.getByRole('button', { name: 'Inline' })
  await inlineButton.click()
  const elsewhereBox = ktRev.locator('[data-comments-elsewhere] [data-comment-composer]').filter({ hasText: 'Original 1' })
  check('inline, the original side’s draft is listed above the diff with its text', !!(await lib.until(async () => (await elsewhereBox.count()) === 1 && (await elsewhereBox.locator('textarea').inputValue().catch(() => '')) === 'Old side draft', HUNG_MS)), await ktRev.innerText().catch(() => ''))
  await elsewhereBox.locator('textarea').fill('Old side draft, typed inline')
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await ktRev.screenshot({ path: path.join(lib.WORK, `cardwork-drafts-inline-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await ktRev.getByRole('button', { name: 'Side by side' }).click()
  check('side by side again, it is back under its line with what was typed inline; the other drafts and the edit kept', !!(await lib.until(async () => (await ktRev.locator('[data-comments-elsewhere]').count()) === 0 && (await oldDraft.locator('textarea').inputValue().catch(() => '')) === 'Old side draft, typed inline', HUNG_MS)) && (await draftKept()) && (await editKept()) && (await range.locator('textarea').inputValue()) === 'On the range', await ktRev.innerText().catch(() => ''))
  await oldDraft.getByRole('button', { name: 'Cancel' }).click()
  await range.getByRole('button', { name: 'Cancel' }).click()
  check('cancelled drafts close', !!(await lib.until(async () => (await oldDraft.count()) === 0 && (await range.count()) === 0, HUNG_MS)))
  await ktDraft.getByRole('button', { name: 'Cancel' }).click()
  check('cancelling the draft keeps the edit too', !!(await lib.until(async () => (await ktDraft.count()) === 0, HUNG_MS)) && (await editKept()))
  await closeDialogs()

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
  const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
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
  const db = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { timeout: 5000 })
  db.prepare('UPDATE cards SET pre_workflow = 1 WHERE number = ?').run(old)
  db.close()
  app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    page = await app.firstWindow()
    await lib.fitWindow(app, page, { width: 1500, height: 950 })
    await lib.appReady(page)
    inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
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
