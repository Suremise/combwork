// For you, the main side (#1269, SPEC §16.8.5, §16.11.4), on fake Claude Code agents (fake-claude/): a builder and a
// reviewer in a lane with a round limit of 1. The reviewer fails the card on the board: Hive asks the user (a request in
// `tasks:forYou`, Decide, with its message for the window), the lane pauses on the card, and a notice says so. The
// user's answer (`tasks:answer`: carry on, one more round) clears it, the lane runs again and the builder is woken with
// the choice, once; an answer to it again is refused. The window (#1276): in a project whose review is the user's,
// its builder asks for a push OK (ask the user, #922's case): the card's For
// you chip, the Task Board icon's count and the board's For you filter show it; Approve in the card dialog records the
// Approval and wakes the builder; Decline (with a reason) returns the card to Active as a round; a reply to a Decide
// question reaches the builder; S14's P4 form (with no review and the OK before merging on `ui` cards, a `ui` card
// approved waits for your OK, then its builder is told to merge). Screenshots in both themes and in Polish. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
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
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const wakes = (agent) => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
    }
    const told = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8') : '')
    const say = async (id, text) => {
      await inv('pty:write', lib.ptyKey(alpha, id), text)
      await lib.sleep(300)
      await inv('pty:write', lib.ptyKey(alpha, id), '\r')
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
    await say(builder.id, `hive hive_lane ${JSON.stringify({ action: 'start', cards: [n], reviewer: 'Reviewer', rounds: 1 })}`)
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

    // An answer that doesn't fit (an approval) is refused; the user's carry on is taken.
    const refused = await inv('tasks:answer', n, item.request, { outcome: 'approved' }).then(() => null, (e) => String(e.message ?? e))
    check("an answer that doesn't fit is refused", /doesn't fit the request/.test(refused ?? ''), refused)
    // The builder hears of the failed verdict first (its loop wake), before the user answers.
    check('the builder is woken with the verdict', !!(await lib.until(async () => wakes('Builder').length === 1, HUNG_MS)), JSON.stringify(wakes('Builder')))
    await lib.until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), HUNG_MS)
    await inv('tasks:answer', n, item.request, { outcome: 'answered', choice: 'carryOn', rounds: 1 })
    check('answered: nothing waits for the user', (await inv('tasks:forYou')).count === 0)
    check('the lane runs again', !!(await lib.until(async () => (await lane())?.state === 'active', HUNG_MS)), JSON.stringify(await lane()))
    const answerWake = (w) => w.startsWith(`[Hive] ${key} (#${n})`) && w.includes('carry on (1 more round)')
    check('the builder is woken with the answer', !!(await lib.until(async () => wakes('Builder').some(answerWake), HUNG_MS)), JSON.stringify(wakes('Builder')))
    const again = await inv('tasks:answer', n, item.request, { outcome: 'answered', choice: 'carryOn', rounds: 1 }).then(() => null, (e) => String(e.message ?? e))
    check('an answer to it again is refused', !!again, String(again))
    await lib.until(() => idle(builder.id), HUNG_MS)
    check('…and the builder was woken once for it', wakes('Builder').filter(answerWake).length === 1, JSON.stringify(wakes('Builder')))
    // The card's history says whom Hive told of the answer (#1269 round 2), as the card dialog shows it.
    const toldLine = 'Told Builder (alpha) of your answer'
    check("the card's history says whom Hive told of the answer", !!(await lib.until(async () => (await card(n))?.history.some((h) => h.by === 'Hive' && h.what === toldLine), HUNG_MS)), JSON.stringify((await card(n))?.history.map((h) => h.what)))
    await showBoard(page)
    await openByTitle(page, n)
    const dialog = page.locator('.dialog', { hasText: `(#${n})` })
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.locator('[data-section="history"]').click()
    const history = dialog.locator('.task-history')
    check('the answer moved nothing: the card is not returned for review by it', (await card(n))?.column === 'review' && !(await card(n))?.history.some((h) => /Returned for review/.test(h.what)), JSON.stringify((await card(n))?.history.map((h) => `${h.by}: ${h.what}`)))
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
      await inv('pty:write', lib.ptyKey(beta, maker.id), text)
      await lib.sleep(300)
      await inv('pty:write', lib.ptyKey(beta, maker.id), '\r')
    }
    await inv('session:start', beta, { agentId: maker.id })
    check('the beta builder starts', !!(await lib.until(makerIdle, HUNG_MS)))
    const q = (await inv('tasks:create', { title: 'Shiny buttons', project: 'beta', labels: ['ui'] })).number
    const moved = await inv('tasks:move', q, 'doing', { agent: maker.id })
    check('the ui card starts in its builder’s worktree', !!moved.moved && (await card(q))?.column === 'doing', JSON.stringify(moved))
    const qKey = (await card(q)).key
    const wakeAbout = (text) => wakes('Maker').some((w) => w.startsWith(`[Hive] ${qKey} (#${q})`) && w.includes(text))

    // #922's case: its builder asks for a push OK.
    await makerSays(`hive hive_ask_user ${JSON.stringify({ card: `#${q}`, kind: 'approve', text: 'OK to push the release tag?' })}`)
    const chip = page.locator(`.task-card[data-task="${q}"] .task-for-you`)
    await showBoard(page)
    check('an agent’s ask shows the For you chip on its card', !!(await lib.until(async () => (await chip.count()) === 1, HUNG_MS)))
    check('…its kind and request in its accessible name', ((await chip.getAttribute('aria-label')) ?? '').includes('Approve: OK to push the release tag?'), await chip.getAttribute('aria-label'))
    const badge = page.locator('.activity-badge[data-badge="board"]')
    check('the Task Board icon counts it', !!(await lib.until(async () => (await badge.innerText().catch(() => '')) === '1', HUNG_MS)) && (await badge.getAttribute('aria-label')) === '1 card waits for you', await badge.getAttribute('aria-label'))
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
    check('the card dialog shows the request: its kind, its words and who asks', !!(await lib.until(async () => /Approve OK to push the release tag\?[\s\S]*Maker asks/.test(await section.innerText().catch(() => '')), HUNG_MS)), await section.innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await section.screenshot({ path: path.join(lib.WORK, `foryou-dialog-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await section.getByRole('button', { name: 'Approve' }).click()
    check('Approve clears it at once', !!(await lib.until(async () => (await section.count()) === 0 && (await chip.count()) === 0, HUNG_MS)))
    const approval = (await inv('tasks:facts', q)).find((f) => f.kind === 'Approval')
    check('…records the Approval', approval?.data.answer === 'approved', JSON.stringify(approval))
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
    await makerSays(`hive hive_cannot_within_rules ${JSON.stringify({ card: `#${q}`, rule: 'submit.checksPassed', why: 'Which database should the tests use?' })}`)
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
    await rSection.getByRole('button', { name: 'Approve' }).click()
    const toldR = () => wakes('Maker').some((w) => w.startsWith(`[Hive] ${rKey} (#${r})`) && w.includes('merge it and report the merge'))
    check('the OK given: the builder is told to merge it', !!(await lib.until(async () => toldR() && (await rSection.count()) === 0, HUNG_MS)), JSON.stringify(wakes('Maker')))
    check('nothing waits for you now', (await inv('tasks:forYou')).count === 0 && (await badge.count()) === 0)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
