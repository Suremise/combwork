// No-code cards (#1277, SPEC §16.7.3): the user makes one from the New Card dialog (No code), its tile and dialog say
// so; S25 (a reviewer agent: submitted with a summary and no revision, passed, Done, no queue, nothing integrated); S38
// (no review, None and Git: submitted with a summary → Done, no revision, no Integrated); a project agent's no-code is
// only proposed (the card stays code, its tile marks the proposal) until the user confirms it in the card's dialog; and
// changing the kind later asks first and records one override. Review: Skip (#1625): offered in the New Card dialog
// only where the project reviews, a card made with it Done at its submission with no reviewer, its tile's mark; an
// agent's proposal (with its reason) answered in the dialog, an agent's change refused (403); the dialog's Skip Review…
// and Review It before submission. Screenshots of the tile and the dialog in both themes.
// Fake Claude Code agents call the Agent API with their own tokens. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47840))
const userData = path.join(lib.WORK, 'nocode-profile')
const ws = path.join(lib.WORK, 'nocode-ws')
const claudeHome = path.join(lib.WORK, 'nocode-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const gamma = path.join(ws, 'gamma')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'one\n', '.gitignore': '.combwork/\n' })
  lib.gitProject(gamma, { 'a.txt': 'one\n', '.gitignore': '.combwork/\n' })
  // HI-2556: gamma lists 1.2.0 as another branch work can merge into.
  lib.git(gamma, ['branch', '1.2.0'])
  // Beta: no version control (None).
  fs.mkdirSync(beta, { recursive: true })
  fs.writeFileSync(path.join(beta, 'notes.md'), 'notes\n')
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws, alpha, beta, gamma].map((d) => d.toLowerCase())))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    // Alpha: a reviewer agent, committed is done, everyone in the project folder. Beta (None) and gamma (Git): no review.
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project' } })
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'none', folder: 'project' } })
    await inv('workflow:setOptions', gamma, { preset: null, options: { review: 'none', finish: 'committed', folder: 'project', otherTargets: ['1.2.0'] } })
    const agents = {
      builder: [alpha, await lib.addAgent(inv, alpha, { name: 'Builder' })],
      reviewer: [alpha, await lib.addAgent(inv, alpha, { name: 'Reviewer' })],
      beta: [beta, await lib.addAgent(inv, beta, { name: 'Writer' })],
      gamma: [gamma, await lib.addAgent(inv, gamma, { name: 'Maker' })]
    }
    const live = async ([p, a]) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === a.id)
    for (const [p, a] of Object.values(agents)) await inv('session:start', p, { agentId: a.id })
    check('the agents start', !!(await lib.until(async () => (await Promise.all(Object.values(agents).map(live))).every((l) => l?.status === 'ready'), HUNG_MS)))

    // Each agent's own token, from its launch, as its Combwork tools read it (intents.cjs).
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (agent) => {
      const sessionId = (await live(agent))?.sessionId
      const launch = await lib.until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const server = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const tokens = Object.fromEntries(await Promise.all(Object.entries(agents).map(async ([k, a]) => [k, await tokenOf(a)])))
    check('each agent has its token', Object.values(tokens).every(Boolean))
    const api = async (who, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const facts = async (n) => (await inv('tasks:facts', n)).map((f) => f.kind)
    const work = (n) => inv('tasks:work', n)
    const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
    const themes = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await target.screenshot({ path: path.join(lib.WORK, `nocode-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    // --- The user makes a no-code card from the New Card dialog.
    await page.getByRole('button', { name: 'Task Board' }).click()
    await page.locator('.board-toolbar button', { hasText: 'New Card' }).first().click()
    const edit = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await edit.waitFor({ timeout: HUNG_MS })
    await edit.locator('.task-title-input').fill('Decide the names')
    await edit.locator('select:has(option[value="alpha"])').first().selectOption('alpha')
    await edit.locator('.kind-new input').check()
    await edit.getByRole('button', { name: 'Add Card' }).click()
    const made = await lib.until(async () => (await inv('tasks:list')).find((c) => c.title === 'Decide the names'), HUNG_MS)
    const n = made?.number
    check('the New Card dialog makes a no-code card', !!made && (await work(n))?.kind === 'no-code', JSON.stringify(await work(n)))
    const key = made?.key
    const mark = tile(n).locator('.task-kind[data-kind="no-code"]')
    check('its tile says No code, with its accessible name', !!(await lib.until(async () => (await mark.count()) === 1, HUNG_MS)) && ((await mark.getAttribute('aria-label')) ?? '').startsWith('No code:'), await mark.getAttribute('aria-label'))
    await themes('tile', tile(n))
    await tile(n).click()
    const dialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await dialog.waitFor({ timeout: HUNG_MS })
    check('its dialog says No code, with a way to change it', !!(await lib.until(async () => (await dialog.locator('.kind-field[data-kind="no-code"]').count()) === 1, HUNG_MS)) && (await dialog.getByRole('button', { name: 'Make It Code…' }).count()) === 1)
    await themes('dialog', dialog.locator('.task-form'))
    await page.keyboard.press('Escape')

    // --- S25: started, submitted with a summary and no revision, reviewed and passed: Done, no queue.
    const ref = encodeURIComponent(key)
    check('the builder starts it', (await api('builder', 'POST', `/v1/tasks/${ref}/start`)).status === 200)
    const sub = await api('builder', 'POST', `/v1/tasks/${ref}/submit`, { summary: 'Names decided: see the comment.' })
    check('S25: submitted with a summary, no revision', sub.status === 200 && sub.body?.to === 'review' && !sub.body?.data?.revision, JSON.stringify(sub.body))
    check('…the summary a comment', (await card(n))?.comments.at(-1)?.text === 'Names decided: see the comment.')
    check('the reviewer starts reviewing it', (await api('reviewer', 'POST', `/v1/tasks/${ref}/start-review`)).status === 200)
    const pass = await api('reviewer', 'POST', `/v1/tasks/${ref}/verdict`, { pass: true, comment: 'Round 1: PASSED' })
    check('S25: a pass takes it to Done', pass.status === 200 && !!(await lib.until(async () => (await card(n))?.column === 'done', HUNG_MS)), JSON.stringify(pass.body))
    const k25 = await facts(n)
    check('…accepted, no queue, nothing integrated', k25.includes('Accepted') && !k25.includes('IntegrationRequested') && !k25.includes('Integrated'), JSON.stringify(k25))

    // --- S38: no review, None and Git: submitted with a summary → Done, no revision, no Integrated.
    for (const [who, project] of [['beta', 'beta'], ['gamma', 'gamma']]) {
      const c = (await inv('tasks:create', { title: `Write the ${project} notes`, project, kind: 'no-code' })).number
      const r = encodeURIComponent((await card(c)).key)
      check(`S38 (${project}): its agent starts it`, (await api(who, 'POST', `/v1/tasks/${r}/start`)).status === 200)
      const s = await api(who, 'POST', `/v1/tasks/${r}/submit`, { summary: 'Written.' })
      const k = await facts(c)
      check(`S38 (${project}): submitted with a summary → Done, no revision, no Integrated`, s.status === 200 && (await card(c))?.column === 'done' && !s.body?.data?.revision && !k.includes('Integrated') && k.includes('Accepted'), JSON.stringify({ body: s.body, facts: k }))
    }

    // --- A project agent's no-code is only proposed: the card stays code until the user confirms it.
    const proposed = await api('builder', 'POST', '/v1/tasks', { title: 'Write the release notes', kind: 'no-code' })
    const p = proposed.body?.number
    check('an agent proposes no-code: the card is code, the proposal on it', proposed.status === 200 && proposed.body?.kind === 'code' && proposed.body?.kindProposed === 'no-code', JSON.stringify(proposed.body))
    const pMark = tile(p).locator('.task-kind[data-kind="proposed"]')
    check('its tile marks the proposal', !!(await lib.until(async () => (await pMark.count()) === 1, HUNG_MS)))
    await tile(p).click()
    await dialog.waitFor({ timeout: HUNG_MS })
    const banner = dialog.locator('[data-section="kind-proposal"]')
    check('its dialog asks: Confirm No Code or Keep as Code', !!(await lib.until(async () => (await banner.count()) === 1, HUNG_MS)))
    await themes('proposal', banner)
    await banner.getByRole('button', { name: 'Confirm No Code' }).click()
    check('confirmed: no code, the proposal answered', !!(await lib.until(async () => (await work(p))?.kind === 'no-code' && (await work(p))?.kindProposed === null, HUNG_MS)) && (await facts(p)).includes('KindDecided'), JSON.stringify(await work(p)))

    // --- Changed later: asked first, one override with the reason.
    await lib.until(async () => (await dialog.getByRole('button', { name: 'Make It Code…' }).count()) === 1, HUNG_MS)
    await dialog.getByRole('button', { name: 'Make It Code…' }).click()
    const ask = page.locator('.dialog', { hasText: 'code?' }).filter({ has: page.locator('.dialog-field-label') })
    check('changing the kind asks first, naming the rule it skips', !!(await lib.until(async () => (await ask.count()) === 1 && (await ask.innerText()).includes("A card's kind is set when it is made"), HUNG_MS)), await ask.innerText().catch(() => ''))
    await themes('change', ask)
    await ask.locator('input').fill('It needs a script after all')
    await ask.getByRole('button', { name: 'Change Anyway' }).click()
    check('Change Anyway: code, one override with the reason', !!(await lib.until(async () => (await work(p))?.kind === 'code', HUNG_MS)) && (await inv('tasks:facts', p)).filter((f) => f.kind === 'Override').map((f) => [f.data.rules.join(), f.data.reason]).join() === 'card.kind,It needs a script after all', JSON.stringify((await inv('tasks:facts', p)).filter((f) => f.kind === 'Override')))
    // An agent can't change it.
    const agentChange = await api('builder', 'PATCH', `/v1/tasks/%23${p}`, { kind: 'no-code' })
    check("an agent can't change a card's kind (403)", agentChange.status === 403 && (await work(p))?.kind === 'code', JSON.stringify(agentChange))
    await page.keyboard.press('Escape')

    // --- Review: Skip (#1625): ticked for a project that reviews, then another project (or none) chosen: no hidden skip is
    // left to block Add Card (HR1's round 1); the card is made there, reviewed as its rules say.
    const skipBox = edit.locator('.review-skip-new input[type="checkbox"]')
    for (const [to, title] of [['gamma', 'Switched to gamma'], ['', 'Switched to the workspace']]) {
      await page.locator('.board-toolbar button', { hasText: 'New Card' }).first().click()
      await edit.waitFor({ timeout: HUNG_MS })
      await edit.locator('.task-title-input').fill(title)
      await edit.locator('select:has(option[value="alpha"])').first().selectOption('alpha')
      await lib.until(async () => (await skipBox.count()) === 1, HUNG_MS)
      await skipBox.check()
      await edit.locator('select:has(option[value="alpha"])').first().selectOption(to)
      check(`ticked in alpha, then ${to || 'no project'}: the tick box goes`, !!(await lib.until(async () => (await skipBox.count()) === 0, HUNG_MS)))
      await edit.getByRole('button', { name: 'Add Card' }).click()
      const switched = await lib.until(async () => (await inv('tasks:list')).find((c) => c.title === title), HUNG_MS)
      check(`…and Add Card makes it there, with no skip`, !!switched && (switched.project ?? '') === to && !(await work(switched.number))?.reviewSkip, JSON.stringify(switched))
    }

    // --- The New Card dialog offers it where the project reviews (alpha), not where it doesn't.
    await page.locator('.board-toolbar button', { hasText: 'New Card' }).first().click()
    await edit.waitFor({ timeout: HUNG_MS })
    await edit.locator('.task-title-input').fill('Build the installer')
    await edit.locator('select:has(option[value="alpha"])').first().selectOption('gamma')
    check("Skip review isn't offered where the project doesn't review (gamma)", !!(await lib.until(async () => (await edit.locator('.kind-new').count()) === 1, HUNG_MS)) && (await skipBox.count()) === 0)
    await edit.locator('select:has(option[value="alpha"])').first().selectOption('alpha')
    check('…and is where it does (alpha)', !!(await lib.until(async () => (await skipBox.count()) === 1, HUNG_MS)))
    await edit.locator('.kind-new input').check()
    await skipBox.check()
    await edit.locator('.review-skip-new input.input').fill('An installer build')
    await themes('skip-new', edit.locator('.task-form'))
    await edit.getByRole('button', { name: 'Add Card' }).click()
    const skipMade = await lib.until(async () => (await inv('tasks:list')).find((c) => c.title === 'Build the installer'), HUNG_MS)
    const s = skipMade?.number
    check('the New Card dialog makes a card that skips review, with the note', !!skipMade && JSON.stringify((await work(s))?.reviewSkip) === JSON.stringify({ by: 'user', reason: 'An installer build' }), JSON.stringify(await work(s)))
    const sMark = tile(s).locator('.task-kind[data-review-skip="skipped"]')
    check('its tile says Review skipped, who and why in its accessible name', !!(await lib.until(async () => (await sMark.count()) === 1, HUNG_MS)) && (await sMark.getAttribute('aria-label')) === 'Review skipped, set by you: An installer build', await sMark.getAttribute('aria-label'))
    await themes('skip-tile', tile(s))
    const sRef = encodeURIComponent(skipMade.key)
    check('the builder starts it', (await api('builder', 'POST', `/v1/tasks/${sRef}/start`)).status === 200)
    const sSub = await api('builder', 'POST', `/v1/tasks/${sRef}/submit`, { summary: 'Built.' })
    const sk = await facts(s)
    check('submitted: Done at once, with no reviewer', sSub.status === 200 && (await card(s))?.column === 'done' && !sk.includes('ReviewStarted') && !sk.includes('Verdict') && sk.includes('Accepted'), JSON.stringify({ body: sSub.body, facts: sk }))

    // --- HI-2556: the New Card dialog's Merges into (gamma lists 1.2.0): the card made on it, its tile says so; the next
    // New Card, and one cancelled and opened again, start on the project's own branch (HR2's round 1: no carry-over).
    // Cancel: a project changed counts as an edit, so it asks to discard first.
    const cancelCard = async () => {
      await edit.getByRole('button', { name: 'Cancel' }).click()
      const discard = page.locator('.dialog', { hasText: 'Discard unsaved changes?' })
      if (await lib.until(async () => (await discard.count()) === 1 || (await edit.count()) === 0, HUNG_MS) && (await discard.count()) === 1) await discard.getByRole('button', { name: 'Discard', exact: true }).click()
      await edit.waitFor({ state: 'detached', timeout: HUNG_MS })
    }
    const newCard = async () => {
      await page.locator('.board-toolbar button', { hasText: 'New Card' }).first().click()
      await edit.waitFor({ timeout: HUNG_MS })
      await edit.locator('select:has(option[value="alpha"])').first().selectOption('gamma')
      const field = edit.locator('#card-target')
      return (await lib.until(async () => (await field.count()) === 1 && (await field.locator('option[value="1.2.0"]').count()) === 1, HUNG_MS)) ? field : null
    }
    let field = await newCard()
    check('HI-2556: the New Card dialog offers Merges into where the project lists another branch (gamma)', !!field)
    if (field) {
      await edit.locator('.task-title-input').fill('Start the 1.2.0 notes')
      await field.selectOption('1.2.0')
      await edit.getByRole('button', { name: 'Add Card' }).click()
      const onRelease = await lib.until(async () => (await inv('tasks:list')).find((c) => c.title === 'Start the 1.2.0 notes'), HUNG_MS)
      check('…the card made merges into 1.2.0', !!onRelease && (await work(onRelease.number))?.cardTarget === '1.2.0', JSON.stringify(onRelease && (await work(onRelease.number))))
      check('…its tile says "Into 1.2.0"', !!onRelease && !!(await lib.until(async () => (await tile(onRelease.number).locator('[data-card-target="1.2.0"]').count()) === 1, HUNG_MS)))
      field = await newCard()
      check('…the next New Card starts on the project’s own branch', !!field && (await field.inputValue()) === '', field ? await field.inputValue() : 'no field')
      if (field) {
        await field.selectOption('1.2.0')
        await cancelCard()
      }
      field = await newCard()
      check('…and so does one opened after a cancelled pick', !!field && (await field.inputValue()) === '', field ? await field.inputValue() : 'no field')
      await cancelCard()
    }

    // --- HI-2851: a gamma card's dialog (gamma doesn't review: no Review field); gamma's rules gain Review while it is
    // closed: the same card opened again (the same project, so not a first read) offers Skip Review…; they lose it while
    // the dialog is open (workflow-changed): the field goes.
    const gammaOptions = (review) => ({ preset: null, options: { review, ...(review === 'agent' ? { noSelfReview: true } : {}), finish: 'committed', folder: 'project', otherTargets: ['1.2.0'] } })
    const gammaCard = (await inv('tasks:list')).find((c) => c.title === 'Switched to gamma')
    const reviewField = edit.locator('[data-review-skip="reviewed"]')
    await tile(gammaCard.number).click()
    await edit.waitFor({ timeout: HUNG_MS })
    check("HI-2851: a gamma card's dialog has no Review field while gamma doesn't review", !!(await lib.until(async () => (await edit.locator('.kind-field[data-kind]').count()) === 1, HUNG_MS)) && (await reviewField.count()) === 0)
    await page.keyboard.press('Escape')
    await edit.waitFor({ state: 'detached', timeout: HUNG_MS })
    await inv('workflow:setOptions', gamma, gammaOptions('agent'))
    await tile(gammaCard.number).click()
    await edit.waitFor({ timeout: HUNG_MS })
    check('…gamma reviewing now, the same card opened again offers Skip Review…', !!(await lib.until(async () => (await reviewField.count()) === 1 && (await edit.getByRole('button', { name: 'Skip Review…' }).count()) === 1, HUNG_MS)))
    await inv('workflow:setOptions', gamma, gammaOptions('none'))
    check('…and gamma no longer reviewing, the open dialog stops offering it', !!(await lib.until(async () => (await reviewField.count()) === 0, HUNG_MS)))
    await page.keyboard.press('Escape')
    await edit.waitFor({ state: 'detached', timeout: HUNG_MS })

    // --- A project agent only proposes it, with its reason: the user keeps the review in the dialog; agents never set it.
    const skipProposed = await api('builder', 'POST', '/v1/tasks', { title: 'Rename the helper', skipReview: 'It only renames a file' })
    const q = skipProposed.body?.number
    check('an agent proposes skipping review: the card is reviewed, the proposal on it', skipProposed.status === 200 && !skipProposed.body?.reviewSkipped && skipProposed.body?.reviewSkipProposed === 'It only renames a file', JSON.stringify(skipProposed.body))
    check('…its tile marks the proposal', !!(await lib.until(async () => (await tile(q).locator('.task-kind[data-review-skip="proposed"]').count()) === 1, HUNG_MS)))
    const agentSkip = await api('builder', 'PATCH', `/v1/tasks/%23${q}`, { skipReview: 'x' })
    check("an agent can't make a card skip review (403)", agentSkip.status === 403 && !(await work(q))?.reviewSkip, JSON.stringify(agentSkip))
    check('skipReview: true is refused (400)', (await api('builder', 'PATCH', `/v1/tasks/%23${q}`, { skipReview: true })).status === 400)
    await tile(q).click()
    await dialog.waitFor({ timeout: HUNG_MS })
    const skipBanner = dialog.locator('[data-section="review-skip-proposal"]')
    check('its dialog asks: Skip Review or Keep Review, with the agent\'s reason', !!(await lib.until(async () => (await skipBanner.count()) === 1, HUNG_MS)) && (await skipBanner.innerText()).includes('It only renames a file'))
    await themes('skip-proposal', skipBanner)
    await skipBanner.getByRole('button', { name: 'Keep Review' }).click()
    check('Keep Review: the proposal answered, the card reviewed', !!(await lib.until(async () => (await work(q))?.reviewSkipProposed === null, HUNG_MS)) && !(await work(q))?.reviewSkip && (await facts(q)).includes('ReviewSkipSet'), JSON.stringify(await work(q)))

    // --- Changed in the dialog before it is submitted: Skip Review… asks why (optional), Review It sets it back.
    const skipButton = dialog.getByRole('button', { name: 'Skip Review…' })
    check('its Review field offers Skip Review…', !!(await lib.until(async () => (await skipButton.count()) === 1, HUNG_MS)))
    await skipButton.click()
    const why = page.locator('.dialog', { hasText: 'Skip the review of' }).filter({ has: page.locator('.dialog-field-label') })
    check('Skip Review… asks first, saying what it means', !!(await lib.until(async () => (await why.count()) === 1 && (await why.innerText()).includes('finish it with no review'), HUNG_MS)), await why.innerText().catch(() => ''))
    await themes('skip-ask', why)
    await why.locator('input').fill('A rename after all')
    await why.getByRole('button', { name: 'Skip Review' }).click()
    check('…then it skips review, with the note', !!(await lib.until(async () => (await work(q))?.reviewSkip?.reason === 'A rename after all', HUNG_MS)))
    check('…and its dialog says so, with Review It', !!(await lib.until(async () => (await dialog.locator('[data-review-skip="skipped"]').count()) >= 1 && (await dialog.getByRole('button', { name: 'Review It' }).count()) === 1, HUNG_MS)))
    await themes('skip-dialog', dialog.locator('.task-form'))
    await dialog.getByRole('button', { name: 'Review It' }).click()
    check('Review It: reviewed again', !!(await lib.until(async () => (await work(q))?.reviewSkip === null, HUNG_MS)))
    await page.keyboard.press('Escape')
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await app
      .firstWindow()
      .then((pg) => pg.screenshot({ path: path.join(lib.WORK, 'nocode-failed.png') }))
      .catch(() => undefined)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
