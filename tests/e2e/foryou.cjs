// For you, the main side (#1269, SPEC §16.8.5, §16.11.4), on fake Claude Code agents (fake-claude/): a builder and a
// reviewer in a lane with a round limit of 1. The reviewer fails the card on the board: Combwork asks the user (a request in
// `tasks:forYou`, Decide, with its message for the window), the lane pauses on the card, and a notice says so. The
// user's answer (`tasks:answer`: carry on, one more round) clears it, the lane runs again and the builder is woken with
// the choice, once; an answer to it again is refused. The window (#1276): in a project whose review is the user's,
// its builder asks for a push OK (ask the user, #922's case): the card's For
// you chip, the Task Board icon's count and the board's For you filter show it; Approve in the card dialog records the
// Approval and wakes the builder; Decline (with a reason) returns the card to Active as a round; a reply to a Decide
// question reaches the builder; S14's P4 form (with no review and the OK before merging on `ui` cards, a `ui` card
// approved waits for your OK, then its builder is told to merge); a question offering Move to Done (#1630) answered with
// one click, the card in Done and the builder told. Screenshots in both themes and in Polish. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
// Dev build only (#1578): it starts this checkout's Electron itself, and Maker is a 0.9 worktree agent
// (agents:testLegacy).
const lib = require('./lib.cjs')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'foryou-profile')
const ws = path.join(lib.WORK, 'foryou-ws')
const claudeHome = path.join(lib.WORK, 'foryou-claude-home')
const notifyLog = path.join(lib.WORK, 'foryou-notify.jsonl')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const PORT = Number(lib.port(47832))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.gitProject(beta)
  const trust = (...dirs) => fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify(dirs.map((d) => d.toLowerCase())))
  trust(alpha, beta)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off', HIVE_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const wakes = (agent) => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
    }
    const told = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8') : '')
    const say = async (id, text) => {
      // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
      await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const lane = async () => (await inv('lanes:list')).find((l) => l.project === 'alpha')

    await page.getByText('alpha', { exact: true }).first().click()
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await lib.until(async () => (await idle(builder.id)) && (await idle(reviewer.id)), HUNG_MS)))
    const n = (await inv('tasks:create', { title: 'Tidy the names', project: 'alpha', agent: builder.id })).number
    await inv('tasks:update', n, { column: 'doing', agent: builder.id })
    const key = (await card(n)).key
    // The builder registers its lane (card-loop does) with one round before the user is asked.
    await say(builder.id, `cw cw_lane ${JSON.stringify({ action: 'start', cards: [n], reviewer: 'Reviewer', rounds: 1 })}`)
    check('the lane is registered, with one round', !!(await lib.until(async () => (await lane())?.rounds === 1, HUNG_MS)), JSON.stringify(await lane()))
    await lib.until(() => idle(builder.id), HUNG_MS)
    check('nothing waits for the user yet', (await inv('tasks:forYou')).count === 0)

    // The reviewer fails it: the round limit. For you, the lane paused on it, the user told.
    await say(builder.id, `boardmove ${n} review`)
    await lib.until(async () => (await card(n))?.column === 'review', HUNG_MS)
    await lib.until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), HUNG_MS)
    await say(reviewer.id, `boardreview ${n} start then boardreview ${n} failed`)
    const asked = await lib.until(async () => {
      const f = await inv('tasks:forYou')
      return f.count === 1 && f
    }, HUNG_MS)
    check('the round limit asks the user (For you)', !!asked, JSON.stringify(asked))
    const item = asked ? asked.items[0] : {}
    check('…a Decide request for the card, with its message', item.card === n && item.kind === 'decide' && item.gate === 'roundLimit' && item.shown?.id === 'workflow.forYou.roundLimit' && item.asker === null, JSON.stringify(item))
    check('…in the project too', (await inv('tasks:forYou', 'alpha')).count === 1 && (await inv('tasks:forYou', 'beta')).count === 0)
    check('the lane pauses on it', !!(await lib.until(async () => (await lane())?.state === 'paused' && (await lane())?.pausedOn === n, HUNG_MS)), JSON.stringify(await lane()))
    check('the user is told', !!(await lib.until(async () => told().includes('failed 1 review: carry on with more rounds'), HUNG_MS)), told())
    // HI-2583: the chip's tooltip names the app, Combwork, as who asks its own requests.
    await showBoard(page)
    const ownChip = page.locator(`.task-card[data-task="${n}"] .task-for-you`)
    await lib.until(async () => (await ownChip.count()) === 1, HUNG_MS)
    const ownTip = await lib.hoverTip(page, ownChip, (t) => t.includes('asks you to decide'), HUNG_MS)
    check("…the chip's tooltip says Combwork asks", ownTip.includes('Combwork asks you to decide'), ownTip)
    await page.locator('.tip:visible').last().screenshot({ path: path.join(lib.WORK, 'foryou-own-request-tip.png') }).catch(() => {})
    await page.mouse.move(5, 5)

    // An answer that doesn't fit (an approval) is refused; the user's carry on is taken.
    const refused = await inv('tasks:answer', n, item.request, { outcome: 'approved' }).then(() => null, (e) => String(e.message ?? e))
    check("an answer that doesn't fit is refused", /doesn't fit the request/.test(refused ?? ''), refused)
    // The builder hears of the failed verdict first (its loop wake), before the user answers.
    check('the builder is woken with the verdict', !!(await lib.until(async () => wakes('Builder').length === 1, HUNG_MS)), JSON.stringify(wakes('Builder')))
    await lib.until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), HUNG_MS)
    await inv('tasks:answer', n, item.request, { outcome: 'answered', choice: 'carryOn', rounds: 1 })
    check('answered: nothing waits for the user', (await inv('tasks:forYou')).count === 0)
    check('the lane runs again', !!(await lib.until(async () => (await lane())?.state === 'active', HUNG_MS)), JSON.stringify(await lane()))
    const answerWake = (w) => w.startsWith(`[CW] ${key}`) && w.includes('carry on (1 more round)')
    check('the builder is woken with the answer', !!(await lib.until(async () => wakes('Builder').some(answerWake), HUNG_MS)), JSON.stringify(wakes('Builder')))
    const again = await inv('tasks:answer', n, item.request, { outcome: 'answered', choice: 'carryOn', rounds: 1 }).then(() => null, (e) => String(e.message ?? e))
    check('an answer to it again is refused', !!again, String(again))
    await lib.until(() => idle(builder.id), HUNG_MS)
    check('…and the builder was woken once for it', wakes('Builder').filter(answerWake).length === 1, JSON.stringify(wakes('Builder')))
    // The card's history says whom Combwork told of the answer (#1269 round 2), as the card dialog shows it.
    const toldLine = 'Told agent Builder (alpha) of your answer'
    check("the card's history says whom Combwork told of the answer", !!(await lib.until(async () => (await card(n))?.history.some((h) => h.by === 'Combwork' && h.what === toldLine), HUNG_MS)), JSON.stringify((await card(n))?.history.map((h) => h.what)))
    await showBoard(page)
    await openByTitle(page, n)
    const dialog = lib.cardDialog(page, await lib.cardLabel(inv, n))
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.locator('[data-section="history"]').click()
    const history = dialog.locator('.task-history')
    // Failed, it went back to Doing with its builder (HI-1946): the answer leaves it there.
    check('the answer moved nothing: the card is not returned for review by it', (await card(n))?.column === 'doing' && !(await card(n))?.history.some((h) => /Returned for review/.test(h.what)), JSON.stringify((await card(n))?.history.map((h) => `${h.by}: ${h.what}`)))
    check('…and the card dialog shows it', !!(await lib.until(async () => (await history.innerText().catch(() => '')).includes(toldLine), HUNG_MS)))
    await history.screenshot({ path: path.join(lib.WORK, 'foryou-history.png') })

    // --- The window (#1276), in beta: the user reviews, its builder in a worktree.
    await page.keyboard.press('Escape')
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'you', noSelfReview: false, finish: 'agentMerges', folder: 'slots' } })
    const maker = await lib.addAgent(inv, beta, { name: 'Maker', location: 'new-worktree' })
    const makerDir = maker.worktree?.path
    trust(alpha, beta, ...(makerDir ? [makerDir] : []))
    const liveIn = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
    const makerIdle = async () => ['ready', 'finished'].includes((await liveIn(beta, maker.id))?.status)
    const makerSays = async (text) => {
      await lib.until(makerIdle, HUNG_MS)
      // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
      await lib.typeLine(inv, lib.ptyKey(beta, maker.id), claudeHome, null, text, { live: () => liveIn(beta, maker.id) })
    }
    await inv('session:start', beta, { agentId: maker.id })
    check('the beta builder starts', !!(await lib.until(makerIdle, HUNG_MS)))
    const q = (await inv('tasks:create', { title: 'Shiny buttons', project: 'beta', labels: ['ui'] })).number
    const moved = await inv('tasks:move', q, 'doing', { agent: maker.id })
    check('the ui card starts in its builder’s worktree', !!moved.moved && (await card(q))?.column === 'doing', JSON.stringify(moved))
    const qKey = (await card(q)).key
    const wakeAbout = (text) => wakes('Maker').some((w) => w.startsWith(`[CW] ${qKey}`) && w.includes(text))

    // #922's case: its builder asks for a push OK.
    await makerSays(`cw cw_ask_user ${JSON.stringify({ card: `#${q}`, kind: 'approve', text: 'OK to push the release tag?' })}`)
    const chip = page.locator(`.task-card[data-task="${q}"] .task-for-you`)
    await showBoard(page)
    check('an agent’s ask shows the For you chip on its card', !!(await lib.until(async () => (await chip.count()) === 1, HUNG_MS)))
    check('…its kind and request in its accessible name', ((await chip.getAttribute('aria-label')) ?? '').includes('Approve: OK to push the release tag?'), await chip.getAttribute('aria-label'))
    const badge = page.locator('.activity-badge[data-badge="board"]')
    check('the Task Board icon counts it', !!(await lib.until(async () => (await badge.innerText().catch(() => '')) === '1', HUNG_MS)) && (await badge.getAttribute('aria-label')) === '1 card waits for you', await badge.getAttribute('aria-label'))
    // #1632: the status bar's "needs you" counts exactly what For you lists, the card's request with it (its builder,
    // finished since, only in the quiet item); its popover lists the request, and a click opens the card.
    const needItem = page.locator('.statusbar .inbox-item:not(.inbox-finished)')
    check('the status bar counts the request: 1 needs you', !!(await lib.until(async () => (await needItem.innerText().catch(() => '')).trim() === '1 needs you', HUNG_MS)), await needItem.innerText().catch(() => ''))
    await needItem.click()
    const requestRow = page.locator(`.inbox-panel .inbox-row[data-request]`)
    check('…its popover lists the request: the card and what it asks', !!(await lib.until(async () => (await requestRow.count()) === 1 && (await requestRow.innerText()).includes('Approve: OK to push the release tag?') && (await requestRow.innerText()).includes(qKey), HUNG_MS)), await requestRow.innerText().catch(() => ''))
    await page.locator('.inbox-panel').screenshot({ path: path.join(lib.WORK, 'foryou-needs-you.png') })
    await requestRow.click()
    const fromInbox = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    check('…and a click opens its card, at its For you section', !!(await lib.until(async () => (await fromInbox.locator('[data-section="for-you"]').count()) === 1, HUNG_MS)))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await fromInbox.count()) === 0, HUNG_MS)
    const filter = page.locator('.board-for-you-filter input')
    await filter.check()
    check('the For you filter shows only the cards waiting for you', !!(await lib.until(async () => (await page.locator('.board .task-card').count()) === 1 && (await page.locator(`.board .task-card[data-task="${q}"]`).count()) === 1, HUNG_MS)), String(await page.locator('.board .task-card').count()))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.locator('.board-view').screenshot({ path: path.join(lib.WORK, `foryou-board-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await filter.uncheck()
    const openQ = async () => {
      await openByTitle(page, q)
      const d = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
      await d.waitFor({ timeout: HUNG_MS })
      return d
    }
    let qDialog = await openQ()
    const section = qDialog.locator('[data-section="for-you"]')
    check('the card dialog shows the request: its kind, its words and who asks', !!(await lib.until(async () => /Approve\s+OK to push the release tag\?[\s\S]*Maker asks/.test(await section.innerText().catch(() => '')), HUNG_MS)), await section.innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await section.screenshot({ path: path.join(lib.WORK, `foryou-dialog-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    // HI-2286: Approve takes an optional note; on an agent's question it says it is recorded as a decision too.
    const note = section.locator('.for-you-approve-note')
    check("Approve's note on an agent's question says it is recorded as your decision", ((await note.getAttribute('placeholder')) ?? '').includes('also recorded as your decision'), await note.getAttribute('placeholder'))
    await note.fill('Approved, but tag it v2 not v1.')
    await section.getByRole('button', { name: 'Approve' }).click()
    check('Approve clears it at once', !!(await lib.until(async () => (await section.count()) === 0 && (await chip.count()) === 0, HUNG_MS)))
    const approval = (await inv('tasks:facts', q)).find((f) => f.kind === 'Approval')
    check('…records the Approval', approval?.data.answer === 'approved', JSON.stringify(approval))
    const noted = await card(q)
    check('…its note as your comment and your decision (HI-2286)', noted?.comments?.at(-1)?.text === 'Approved, but tag it v2 not v1.' && (noted?.decisions ?? []).some((d) => d.text === 'Approved, but tag it v2 not v1.'), JSON.stringify({ comments: noted?.comments, decisions: noted?.decisions }))
    check('…and wakes the builder that asked', !!(await lib.until(async () => wakeAbout('approved "OK to push the release tag?"'), HUNG_MS)), JSON.stringify(wakes('Maker')))
    await page.keyboard.press('Escape')

    // The user's review: Decline returns it to its builder as a round, with the reason.
    const commitIn = (file) => {
      fs.writeFileSync(path.join(makerDir, file), `${file}\n`)
      lib.git(makerDir, ['add', '-A'])
      lib.git(makerDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file])
    }
    commitIn('button.css')
    check('submitted for the user’s review', !!(await inv('tasks:move', q, 'review')).moved && (await card(q))?.column === 'review')
    qDialog = await openQ()
    check('…it waits for you: Approve or Decline', !!(await lib.until(async () => (await section.innerText().catch(() => '')).includes('waits for your review'), HUNG_MS)), await section.innerText().catch(() => ''))
    await section.getByRole('button', { name: 'Decline…' }).click()
    const why = page.locator('.dialog', { hasText: 'Why? The agent waiting on it reads your reason.' })
    await why.waitFor({ timeout: HUNG_MS })
    await why.locator('input').fill('Rename the button')
    await why.getByRole('button', { name: 'OK' }).click()
    check('Decline returns it to Active (Doing) as a round', !!(await lib.until(async () => (await card(q))?.column === 'doing', HUNG_MS)) && (await inv('tasks:work', q))?.rounds === 1, JSON.stringify({ column: (await card(q))?.column, rounds: (await inv('tasks:work', q))?.rounds }))
    check('…and the builder hears why', !!(await lib.until(async () => wakeAbout('Rename the button'), HUNG_MS)), JSON.stringify(wakes('Maker')))
    await page.keyboard.press('Escape')

    // A Decide question: the reply reaches the builder.
    await makerSays(`cw cw_cannot_within_rules ${JSON.stringify({ card: `#${q}`, rule: 'submit.checksPassed', why: 'Which database should the tests use?' })}`)
    qDialog = await openQ()
    check('a Decide question shows with a reply box', !!(await lib.until(async () => (await section.locator('textarea').count()) === 1, HUNG_MS)), await section.innerText().catch(() => ''))
    await section.locator('textarea').fill('SQLite in memory')
    // An answer written and not sent is kept like a comment (HR3's #1276 round 1): closing asks; Keep Editing keeps it.
    const discard = page.locator('.dialog', { hasText: 'Discard unsaved changes?' })
    for (const how of ['Escape', 'Save']) {
      if (how === 'Escape') await page.keyboard.press('Escape')
      else await qDialog.getByRole('button', { name: 'Save', exact: true }).click()
      check(`${how} with an answer not sent asks first`, !!(await lib.until(async () => (await discard.count()) === 1 && (await discard.innerText()).includes('the answer you are writing'), HUNG_MS)), await discard.innerText().catch(() => ''))
      await discard.getByRole('button', { name: 'Keep Editing' }).click()
      check('…Keep Editing keeps the dialog and the answer', !!(await lib.until(async () => (await discard.count()) === 0, HUNG_MS)) && (await qDialog.count()) === 1 && (await section.locator('textarea').inputValue()) === 'SQLite in memory')
    }
    await section.getByRole('button', { name: 'Send Reply' }).click()
    check('the reply reaches the builder', !!(await lib.until(async () => wakeAbout('SQLite in memory'), HUNG_MS)), JSON.stringify(wakes('Maker')))
    // Sent: nothing left to lose, so closing asks nothing.
    await page.keyboard.press('Escape')
    check('…and once sent, closing asks nothing', !!(await lib.until(async () => (await qDialog.count()) === 0, HUNG_MS)) && (await discard.count()) === 0)

    // The user's review approved: the card moves on (Approved), its builder told.
    commitIn('button-name.css')
    await inv('tasks:move', q, 'review')
    qDialog = await openQ()
    await lib.until(async () => (await section.innerText().catch(() => '')).includes('waits for your review'), HUNG_MS)
    await section.getByRole('button', { name: 'Approve' }).click()
    check('Approve in the dialog moves the card on (Passed), its builder told to merge', !!(await lib.until(async () => (await card(q))?.column === 'passed' && wakeAbout('merge it and report the merge'), HUNG_MS)), JSON.stringify({ column: (await card(q))?.column, wakes: wakes('Maker') }))
    await page.keyboard.press('Escape')
    await inv('tasks:move', q, 'done', { confirm: true, reason: 'Merged by hand' })

    // S14's P4 form: no review, the OK before merging on `ui` cards; a `ui` card approved waits for your OK.
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'none', noSelfReview: false, finish: 'agentMerges', folder: 'slots', okBefore: { mode: 'labels', labels: ['ui'] } } })
    const r = (await inv('tasks:create', { title: 'Release notes', project: 'beta', labels: ['ui'] })).number
    await inv('tasks:move', r, 'doing', { agent: maker.id })
    commitIn('notes.md')
    await inv('tasks:move', r, 'passed')
    const rKey = (await card(r)).key
    await openByTitle(page, r)
    const rDialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await rDialog.waitFor({ timeout: HUNG_MS })
    const rSection = rDialog.locator('[data-section="for-you"]')
    check('approved, the ui card waits for your OK before merging', !!(await lib.until(async () => (await rSection.innerText().catch(() => '')).includes(`${rKey} is approved: OK to merge?`), HUNG_MS)) && (await card(r))?.column === 'passed', await rSection.innerText().catch(() => ''))
    // In Polish (as main sends a change of language, with Polish's own catalogue).
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'pl')
    const messages = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
    await speak({ ...base, code: 'pl', locale: 'pl', messages })
    check('the section in Polish', !!(await lib.until(async () => /dla ciebie/i.test(await rSection.innerText().catch(() => '')) && (await rSection.innerText().catch(() => '')).includes('Zatwierdź'), HUNG_MS)), await rSection.innerText().catch(() => ''))
    await rSection.screenshot({ path: path.join(lib.WORK, 'foryou-dialog-pl.png') })
    await speak(base)
    await lib.until(async () => (await rSection.innerText().catch(() => '')).includes('Approve'), HUNG_MS)
    // HI-2286: on Combwork's own OK the note is a comment only.
    check("Approve's note on Combwork's OK says it is your comment", ((await rSection.locator('.for-you-approve-note').getAttribute('placeholder')) ?? '').includes('added as your comment'), await rSection.locator('.for-you-approve-note').getAttribute('placeholder'))
    await rSection.getByRole('button', { name: 'Approve' }).click()
    const toldR = () => wakes('Maker').some((w) => w.startsWith(`[CW] ${rKey}`) && w.includes('merge it and report the merge'))
    check('the OK given: the builder is told to merge it', !!(await lib.until(async () => toldR() && (await rSection.count()) === 0, HUNG_MS)), JSON.stringify(wakes('Maker')))
    check('nothing waits for you now', (await inv('tasks:forYou')).count === 0 && (await badge.count()) === 0)
    await page.keyboard.press('Escape')

    // #1630 (HB1's HI-1624): a card already done elsewhere; its builder offers Move to Done with a reason, one click.
    const s = (await inv('tasks:create', { title: 'Done elsewhere', project: 'beta' })).number
    await inv('tasks:move', s, 'doing', { agent: maker.id })
    const sKey = (await card(s)).key
    await makerSays(`cw cw_ask_user ${JSON.stringify({ card: `#${s}`, kind: 'decide', text: 'Already done by #1277: how do I close it?', actions: [{ kind: 'done', reason: 'already done by #1277' }, { kind: 'unblock' }] })}`)
    await openByTitle(page, s)
    const sDialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await sDialog.waitFor({ timeout: HUNG_MS })
    const sSection = sDialog.locator('[data-section="for-you"]')
    const offer = sSection.locator('[data-offer="done"]')
    check('an offered action shows as a button with its reason', !!(await lib.until(async () => (await offer.count()) === 1 && (await offer.locator('input').inputValue()) === 'already done by #1277', HUNG_MS)), await sSection.innerText().catch(() => ''))
    check('…only what the card allows now (it is not blocked: no Unblock)', (await sSection.locator('[data-offer="unblock"]').count()) === 0)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sSection.screenshot({ path: path.join(lib.WORK, `foryou-actions-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await offer.getByRole('button', { name: 'Move to Done' }).click()
    check('one click moves it to Done and answers the question', !!(await lib.until(async () => (await card(s))?.column === 'done' && (await inv('tasks:forYou')).count === 0, HUNG_MS)), JSON.stringify({ column: (await card(s))?.column }))
    const chose = (await inv('tasks:facts', s)).find((f) => f.kind === 'Approval')
    check('…recording the action and its reason', chose?.data.action === 'done' && chose?.data.note === 'already done by #1277', JSON.stringify(chose))
    check('…and the builder hears what was chosen', !!(await lib.until(async () => wakes('Maker').some((w) => w.startsWith(`[CW] ${sKey}`) && w.includes('moved it to Done (already done by #1277)')), HUNG_MS)), JSON.stringify(wakes('Maker')))
    await page.keyboard.press('Escape')

    // HI-1734: a question offering one action (Skip Review): beside Send Reply, "Skip Review With This Reply" does it with
    // the typed reply as its reason, and answers the question.
    // Its rules review it (beta's are review-free from the OK step on): reviewed by you for this card, as before after it.
    const betaOptions = { review: 'none', noSelfReview: false, finish: 'agentMerges', folder: 'slots', okBefore: { mode: 'labels', labels: ['ui'] } }
    await inv('workflow:setOptions', beta, { preset: null, options: { ...betaOptions, review: 'you', okBefore: { mode: 'never', labels: [] } } })
    const k = (await inv('tasks:create', { title: 'Checks only', project: 'beta' })).number
    await inv('tasks:move', k, 'doing', { agent: maker.id })
    await makerSays(`cw cw_ask_user ${JSON.stringify({ card: `#${k}`, kind: 'decide', text: 'May we skip review for this checks-only change?', actions: [{ kind: 'skipReview' }] })}`)
    await openByTitle(page, k)
    const kDialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await kDialog.waitFor({ timeout: HUNG_MS })
    const kSection = kDialog.locator('[data-section="for-you"]')
    const agree = kSection.getByRole('button', { name: 'Skip Review With This Reply' })
    check('one action offered: Skip Review shows, and "Skip Review With This Reply" beside Send Reply', !!(await lib.until(async () => (await kSection.locator('[data-offer="skipReview"]').count()) === 1 && (await agree.count()) === 1, HUNG_MS)), await kSection.innerText().catch(() => ''))
    check('…disabled until a reply is typed', await agree.isDisabled())
    await kSection.locator('textarea.for-you-reply').fill('Yes: checks only, nothing to review.')
    check('…enabled with a reply', !!(await lib.until(async () => !(await agree.isDisabled()), HUNG_MS)))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await kSection.screenshot({ path: path.join(lib.WORK, `foryou-agree-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await agree.click()
    const skipped = async () => (await inv('tasks:facts', k)).filter((f) => f.kind === 'ReviewSkipSet').at(-1)?.data
    check('one click skips its review with the reply as the reason, and answers the question', !!(await lib.until(async () => (await skipped())?.skip === true && (await skipped())?.reason === 'Yes: checks only, nothing to review.' && (await inv('tasks:forYou')).count === 0, HUNG_MS)), JSON.stringify({ skip: (await skipped()) ?? null, waiting: (await inv('tasks:forYou')).items.map((i) => i.text) }))
    await page.keyboard.press('Escape')
    await inv('workflow:setOptions', beta, { preset: null, options: betaOptions })

    // #1637: an agent's question is Markdown (HB5's HI-1630 design question): rendered as card comments are, never the
    // raw marks, and a long one folded with Show all.
    const m = (await inv('tasks:create', { title: 'Design question', project: 'beta' })).number
    await inv('tasks:move', m, 'doing', { agent: maker.id })
    const point = (num, label, body) => `${num}. **${label}:** ${body}`
    const design = [
      'HI-1630 design: OK to build it this way?',
      '',
      point(1, 'Agent side', '`cw_ask_user` gets an optional `actions` list, at most 3: `done`, `noCode`, `unblock`.'),
      point(2, 'For you', 'each action shows as a button with its reason, which you can edit.'),
      point(3, 'One click', 'it does what the board does today, as you, with the reason.'),
      point(4, 'Send Reply and Record as Decision', 'get tooltips that say what each does.'),
      point(5, 'Agent guidance', 'one sentence in the tool description saying when to offer actions.'),
      '',
      ...Array.from({ length: 8 }, (_, i) => `A further paragraph ${i + 1}, so the question is longer than the fold.`)
    ].join('\n')
    await makerSays(`cw cw_ask_user ${JSON.stringify({ card: `#${m}`, kind: 'decide', text: design })}`)
    await openByTitle(page, m)
    const mDialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await mDialog.waitFor({ timeout: HUNG_MS })
    const question = mDialog.locator('[data-section="for-you"] .for-you-question')
    check('an agent’s question renders as Markdown: numbered points', !!(await lib.until(async () => (await question.locator('ol > li').count()) === 5, HUNG_MS)), await question.innerHTML().catch(() => ''))
    check('…bold labels and code', (await question.locator('strong', { hasText: 'Agent side:' }).count()) === 1 && (await question.locator('code', { hasText: 'cw_ask_user' }).count()) === 1)
    check('…none of the raw marks', !/\*\*|`/.test(await question.innerText()), await question.innerText())
    check('…its line breaks kept', (await question.locator('p br').count()) >= 7, await question.innerHTML())
    const more = mDialog.locator('.for-you-more')
    check('a long question is folded, with Show all', (await more.count()) === 1 && (await more.innerText()).trim() === 'Show all' && (await question.evaluate((el) => el.scrollHeight > el.clientHeight + 1)), await more.innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await mDialog.locator('[data-section="for-you"]').screenshot({ path: path.join(lib.WORK, `foryou-markdown-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await more.click()
    check('…Show all shows it whole', !!(await lib.until(async () => (await question.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)) && (await more.innerText()).trim() === 'Show less', HUNG_MS)), await more.innerText().catch(() => ''))
    await page.keyboard.press('Escape')

    // HR5's round 1 (#1637): a question that fits, then wraps past the fold once the window is zoomed in, is folded
    // with Show all then, and not once it fits again. Zoomed to 300%: the dialog narrows with the window's width.
    const f = (await inv('tasks:create', { title: 'Fits at first', project: 'beta' })).number
    await inv('tasks:move', f, 'doing', { agent: maker.id })
    const fits = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}: a sentence that fits on one line here, and wraps once the window is zoomed in.`).join('\n')
    await makerSays(`cw cw_ask_user ${JSON.stringify({ card: `#${f}`, kind: 'decide', text: fits })}`)
    await openByTitle(page, f)
    const fDialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await fDialog.waitFor({ timeout: HUNG_MS })
    const fQuestion = fDialog.locator('[data-section="for-you"] .for-you-question')
    const fMore = fDialog.locator('.for-you-more')
    check('a question that fits has no Show all', !!(await lib.until(async () => (await fQuestion.locator('p br').count()) === 5, HUNG_MS)) && (await fMore.count()) === 0, await fQuestion.innerHTML().catch(() => ''))
    const zoom = (factor) => app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), factor)
    await zoom(3)
    try {
      check('…zoomed in, it wraps past the fold: Show all appears', !!(await lib.until(async () => (await fMore.count()) === 1 && (await fQuestion.evaluate((el) => el.scrollHeight > el.clientHeight + 1)), HUNG_MS)), JSON.stringify({ more: await fMore.count(), box: await fQuestion.evaluate((el) => [el.clientWidth, el.clientHeight, el.scrollHeight, window.devicePixelRatio]) }))
    } finally {
      await zoom(1)
    }
    check('…and goes once it fits again', !!(await lib.until(async () => (await fMore.count()) === 0, HUNG_MS)), String(await fMore.count()))

    // HI-1931: "need you" counts things, not requests. A card with three questions counts once, and shows "3 questions"
    // in the popover with each under it; its builder stopped at a prompt (on its own cards, which are counted) isn't
    // counted again, and shows under one of them.
    await page.keyboard.press('Escape')
    await lib.until(async () => (await fDialog.count()) === 0, HUNG_MS)
    const needCount = async () => Number(((await needItem.innerText().catch(() => '')).match(/\d+/) ?? ['0'])[0])
    await lib.until(async () => (await needCount()) > 0, HUNG_MS)
    const before = await needCount()
    const t = (await inv('tasks:create', { title: 'Three questions', project: 'beta' })).number
    await inv('tasks:move', t, 'doing', { agent: maker.id })
    for (const text of ['First: which icon?', 'Second: which colour?', 'Third: ship it today?']) await makerSays(`cw cw_ask_user ${JSON.stringify({ card: `#${t}`, kind: 'decide', text })}`)
    const forYouOf = async (num) => ((await inv('tasks:forYou')).items ?? []).filter((i) => i.card === num).length
    check('three requests on one card', !!(await lib.until(async () => (await forYouOf(t)) === 3, HUNG_MS)), String(await forYouOf(t)))
    check('…the status bar counts the card once', !!(await lib.until(async () => (await needCount()) === before + 1, HUNG_MS)), JSON.stringify({ before, now: await needCount() }))
    const tip = await lib.hoverTip(page, needItem, (x) => /need/.test(x), HUNG_MS)
    check('…its tooltip says cards (and agents), not requests', /\d+ cards? (and \d+ agents? )?needs? you\. Click to see them\./.test(tip), tip)
    await page.mouse.move(5, 5)
    if (!(await page.locator('.inbox-panel').count())) await needItem.click()
    const group = page.locator(`.inbox-panel [data-card-group="${t}"]`)
    check('…the popover: the card once, "3 questions", each under it', !!(await lib.until(async () => (await group.count()) === 1 && /3 questions/.test(await group.innerText()) && (await group.locator('.inbox-under[data-request]').count()) === 3, HUNG_MS)), await group.innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme)
      await page.locator('.inbox-panel').screenshot({ path: path.join(lib.WORK, `foryou-grouped-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await group.locator('.inbox-under[data-request]').nth(1).click()
    const tDialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    check('…a request under it opens its card', !!(await lib.until(async () => (await tDialog.count()) === 1 && (await tDialog.locator('.task-title-input').inputValue()) === 'Three questions', HUNG_MS)))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await tDialog.count()) === 0, HUNG_MS)
    // HI-1932: the user's answer, given in a chat with the Assistant, recorded by it as a decision naming the questions
    // it answers, closes those: in one write, the asker told, the card's resolved list and history saying who recorded
    // it. Maker's lane on the card pauses while any question waits for the user, and goes on once none does.
    await makerSays(`cw cw_lane ${JSON.stringify({ action: 'start', cards: [`#${t}`] })}`)
    const betaLane = async () => (await inv('lanes:list')).find((l) => l.project === 'beta' && l.cards.some((c) => c.number === t))
    check("Maker's lane on the card pauses: waiting for the user", !!(await lib.until(async () => (await betaLane())?.state === 'paused' && (await betaLane())?.pausedOn === t, HUNG_MS)), JSON.stringify(await betaLane()))
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    const assistantLive = async () => (await inv('session:live')).find((x) => x.projectPath.toLowerCase() === home.toLowerCase() && x.agentId === 'assistant')
    await lib.until(async () => ['waiting', 'ready'].includes((await assistantLive())?.status), HUNG_MS)
    if ((await assistantLive())?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
    check('the Assistant runs', !!(await lib.until(async () => (await assistantLive())?.status === 'ready', HUNG_MS)))
    const tokenFile = path.join(userData, 'assistant-api', `${require('crypto').createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistantToken = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
    const asAssistant = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${assistantToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, json: await res.json().catch(() => null) }
    }
    const read = await asAssistant('GET', `/v1/tasks/${t}`)
    const waiting = read.json?.forYou ?? []
    check("cw_read_task lists the card's open requests with their ids", read.status === 200 && waiting.length === 3 && waiting.every((x) => /\/r\d+$/.test(x.request)) && waiting[0].text === 'First: which icon?', JSON.stringify(read.json?.forYou))
    // HI-1992: at the top, just after its decisions (it has none yet: after its title), each with who asked and when; in
    // every form of cw_read_task, the latest comment's too.
    const keys = Object.keys(read.json ?? {})
    check('…at the top, after its title, each saying who asked and when', keys.indexOf('forYou') === keys.indexOf('title') + 1 && waiting.every((x) => x.asker === 'Maker' && !Number.isNaN(Date.parse(x.since))), JSON.stringify({ keys: keys.slice(0, 4), waiting }))
    const forms = { comments: `/v1/tasks/${t}?comments=1&history=false`, summary: `/v1/tasks/${t}?summary=true&history=false`, latest: `/v1/tasks/${t}/comments/latest`, latestSummary: `/v1/tasks/${t}/comments/latest?summary=true` }
    const inForms = {}
    for (const [name, route] of Object.entries(forms)) inForms[name] = (await asAssistant('GET', route)).json?.forYou?.map((x) => x.text)
    check('…in every form: newest comments, summary, latest comment', Object.values(inForms).every((x) => JSON.stringify(x) === JSON.stringify(waiting.map((w) => w.text))), JSON.stringify(inForms))
    const [first, second, third] = waiting.map((x) => x.request)
    // The listing reads them for all its cards at once (HR1 r1); its short rows carry none.
    const listed = await asAssistant('GET', '/v1/tasks?project=beta')
    const shortRows = await asAssistant('GET', '/v1/tasks?project=beta&view=short')
    check('…the listing has them too; its short rows not', listed.json?.find?.((c) => c.number === t)?.forYou?.length === 3 && shortRows.status === 200 && shortRows.json.every((c) => c.forYou === undefined), JSON.stringify({ listed: listed.json?.find?.((c) => c.number === t)?.forYou, short: shortRows.status }))
    // Refused at the API's boundary, as sent (HR1 r1): ids that aren't strings, and other changes alongside, even those
    // made outside the card's patch. Nothing of any of them is written.
    const wrong = [
      { decision: 'x', answers: [[first]] },
      { decision: 'x', answers: [7] },
      { decision: 'x', answers: [first], skipReview: 'Checks only.' },
      { decision: 'x', answers: [first], kind: 'no-code', override: { reason: 'r' } },
      { decision: 'x', answers: [first], attachments: [path.join(userData, 'none.png')] }
    ]
    const refusals = []
    for (const body of wrong) refusals.push((await asAssistant('PATCH', `/v1/tasks/${t}`, body)).status)
    const untouched = (await asAssistant('GET', `/v1/tasks/${t}`)).json
    check('…a decision whose answers come wrongly is refused whole, nothing written', refusals.every((code) => code === 400) && !untouched?.decisions?.length && untouched?.forYou?.length === 3 && !untouched?.reviewSkipped && untouched?.kind !== 'no-code', JSON.stringify({ refusals, decisions: untouched?.decisions, forYou: untouched?.forYou?.length, reviewSkipped: untouched?.reviewSkipped, kind: untouched?.kind }))
    const decided = await asAssistant('PATCH',`/v1/tasks/${t}`, { decision: 'The bee icon, in amber.', answers: [first, second] })
    check("the Assistant's decision naming two of them is taken", decided.status === 200, JSON.stringify(decided.json))
    check('…those two leave For you; the third stays, still counted', !!(await lib.until(async () => (await forYouOf(t)) === 1, HUNG_MS)) && (await inv('tasks:forYou')).items.some((i) => i.request === third), String(await forYouOf(t)))
    check('…the lane still waits for the user, on the third', (await betaLane())?.state === 'paused' && (await betaLane())?.pausedOn === t, JSON.stringify(await betaLane()))
    const cardNow = await card(t)
    const decisionId = cardNow.decisions?.find((d) => d.text === 'The bee icon, in amber.')?.id
    check('…the decision on the card, recorded by the Assistant', !!decisionId && cardNow.decisions.find((d) => d.id === decisionId).recordedBy === 'Assistant', JSON.stringify(cardNow.decisions))
    check('…a history line for each, by the Assistant', cardNow.history.filter((h) => h.by === 'Assistant' && h.what.startsWith('Closed a question for you with your decision')).length === 2, JSON.stringify(cardNow.history.slice(-4)))
    check('…Maker is told, once', !!(await lib.until(async () => wakes('Maker').filter((x) => x.includes('with a decision (recorded by Assistant): The bee icon, in amber.')).length === 1, HUNG_MS)), JSON.stringify(wakes('Maker').slice(-3)))
    await openByTitle(page, t)
    const resolvedIn = page.locator('.dialog').filter({ has: page.locator('.task-title-input') }).locator('[data-section="for-you"] [data-resolved] .for-you-resolved-row')
    check("the card's For you section lists them: the question, the decision (by its id), recorded by the Assistant", !!(await lib.until(async () => (await resolvedIn.count()) === 2, HUNG_MS)) && (await resolvedIn.evaluateAll((els) => els.map((e) => e.dataset.decision))).every((d) => d === decisionId) && (await resolvedIn.first().innerText()).includes('By your decision: “The bee icon, in amber.”, recorded by the Assistant') && /Second: which colour\?/.test(await resolvedIn.first().innerText()), await resolvedIn.first().innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme)
      await page.locator('.dialog [data-section="for-you"]').screenshot({ path: path.join(lib.WORK, `foryou-resolved-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.keyboard.press('Escape')
    // The third, answered in For you the ordinary way: none waits now, and the lane goes on.
    await inv('tasks:answer', t, third, { outcome: 'answered', reply: 'Ship it today.' })
    check('the third answered in For you: none waits, and the lane runs again', !!(await lib.until(async () => (await forYouOf(t)) === 0 && (await betaLane())?.state === 'active', HUNG_MS)), JSON.stringify(await betaLane()))
    // Its builder stops at a permission prompt: an agent that needs you, on cards already counted.
    const beforeMaker = await needCount()
    await makerSays('ask work 300')
    check('Maker waits at a prompt', !!(await lib.until(async () => (await liveIn(beta, maker.id))?.status === 'waiting', HUNG_MS)))
    await needItem.click()
    const makerRow = page.locator('.inbox-panel .inbox-row', { hasText: 'Maker' })
    check('…listed under one of its cards, not counted again', !!(await lib.until(async () => (await makerRow.count()) === 1 && (await makerRow.evaluate((el) => el.classList.contains('inbox-under') && !!el.closest('[data-card-group]'))), HUNG_MS)) && (await needCount()) === beforeMaker, JSON.stringify({ count: await needCount(), was: beforeMaker, under: await makerRow.evaluate((el) => el.className).catch(() => '') }))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme)
      await page.locator('.inbox-panel').screenshot({ path: path.join(lib.WORK, `foryou-grouped-agent-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
