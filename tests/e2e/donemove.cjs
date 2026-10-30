// Agents move cards into and out of Done like any other column: an agent's hive tools (the fake Claude Code's
// "boardmove N COLUMN", which calls the API as they do) move a card to Done with no question, its history names the
// agent, and the move is undone from the board (right-click → Move to) or by the agent. The card's prompt asks for
// Review when the work is done. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'donemove-profile')
const ws = path.join(lib.WORK, 'donemove-ws')
const claudeHome = path.join(lib.WORK, 'donemove-claude-home')
const alpha = path.join(ws, 'alpha')
const calls = path.join(claudeHome, 'fake-calls.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome]) fs.mkdirSync(d, { recursive: true })
  // Every read of the agent's input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47906), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  // The board's own moves, as before 1.0's rules (#1275): its project has every rule off, where Review isn't a stage, so
  // with the rules enforced the board refuses it (boardgates covers that); turned off, every column is a plain move.
  await inv('advanced:set', 'hive.workflow.enforce', false)
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Mover' })
  const key = lib.ptyKey(alpha, agent.id)
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 20000)))

  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  await inv('tasks:create', { title: 'Greeting', project: 'alpha', column: 'review' })
  const callsSoFar = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0)
  const lastCall = () => JSON.parse(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1))
  // Each prompt is typed once the fake takes prompts, and waited for by its own turn (#684, lib.fakePrompts).
  const prompts = lib.fakePrompts(inv, key, live, { home: claudeHome })
  const run = async (text) => {
    const before = callsSoFar()
    check(`the prompt "${text}" is answered`, !!(await prompts.say(text)))
    return callsSoFar() > before ? lastCall() : null
  }
  const moves = async (n) => (await card(n)).history.filter((h) => h.what.startsWith('Moved to')).map((h) => `${h.by}: ${h.what}`)

  // --- The agent moves the card to Done: no question, and its history says who did it.
  let call = await run('boardmove 1 done')
  check('an agent moves a card to Done', call?.status === 200 && (await card(1)).column === 'done', JSON.stringify(call))
  check('with no question', (await page.locator('.dialog').count()) === 0 && (await page.locator('.assistant-question').count()) === 0)
  check('its history names the agent and the column', (await moves(1)).at(-1) === 'Mover (alpha): Moved to Done', JSON.stringify(await moves(1)))

  // --- Undone from the board: right-click → Move to → Review.
  await page.getByRole('button', { name: 'Task Board' }).click()
  const tile = page.locator('.task-card[data-task="1"]')
  await tile.waitFor({ timeout: 5000 })
  await tile.click({ button: 'right' })
  await page.locator('.menu .menu-item', { hasText: 'Review' }).click()
  check('the user moves it back to Review from the board', !!(await until(async () => (await card(1)).column === 'review', 5000)))
  check('…and that is in its history too', (await moves(1)).at(-1) === 'You: Moved to Review', JSON.stringify(await moves(1)))
  await page.screenshot({ path: path.join(lib.WORK, 'donemove-board.png') })

  // --- And by the agent: into Done and back out again.
  await run('boardmove 1 done')
  call = await run('boardmove 1 doing')
  check('an agent moves a card back out of Done', call?.status === 200 && (await card(1)).column === 'doing', JSON.stringify(call))
  check('every move is in its history', JSON.stringify((await moves(1)).slice(-2)) === JSON.stringify(['Mover (alpha): Moved to Done', 'Mover (alpha): Moved to Doing']), JSON.stringify(await moves(1)))
  // The card dialog says the window's column names (#1458): Active, where agents' English says Doing.
  await tile.click()
  const dialog = lib.cardDialog(page, await lib.cardLabel(inv, 1))
  await dialog.waitFor({ timeout: 5000 })
  await dialog.locator('.task-section-h[data-section="history"]').click()
  const history = dialog.locator('.task-history')
  const shownMoves = async () => (await history.innerText().catch(() => '')).split('\n').filter((l) => / Moved to /.test(l))
  check("the card's history in the window says Active", !!(await until(async () => (await shownMoves()).some((l) => l.endsWith('Mover (alpha) Moved to Active')), 5000)) && !(await shownMoves()).some((l) => / Moved to (Doing|Passed)$/.test(l)), JSON.stringify(await shownMoves()))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 5000 })

  // --- The card's prompt still asks for Review when the work is done (and Done only once merged, or when the user asks).
  const n = (await inv('tasks:create', { title: 'Docs', project: 'alpha' })).number
  await inv('tasks:start', n, { kind: 'agent', agentId: agent.id })
  check('Start puts the card in Doing', !!(await until(async () => (await card(n)).column === 'doing', 10000)))
  // The prompt names the card by its key with the number the tools take (#1219): its own key, from the board.
  const nName = `${(await card(n)).key}`
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(nName), nName)
  const transcript = path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'), `${(await live()).sessionId}.jsonl`)
  const prompt = await until(async () => {
    const lines = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.includes(`task ${nName} `)) : []
    // Read from its inbox (#650: the task's doorbell names it; the hive_inbox call's result has its text).
    const content = lines.length ? JSON.parse(lines.at(-1)).message.content : null
    return typeof content === 'string' || content === null ? content : (content.find?.((c) => typeof c.content === 'string')?.content ?? null)
  }, 15000)
  // The prompt points to the work-on-card skill, which the agent's launch carries, and which says Review when done (by
  // submitting it, #1274) and Done only once merged (#170). The session's Hive instructions say both too, with "or when the
  // user asks", for a session without the skill (tests/guidance.test.ts checks those).
  check('the card prompt points to the work-on-card skill', typeof prompt === 'string' && prompt.includes('Use the work-on-card skill.'), String(prompt))
  const skill = path.join(alpha, '.hive', `launch-${agent.id}`, 'plugin', 'skills', 'work-on-card', 'SKILL.md')
  // HI-2011: finishing after review is in its reference file beside SKILL.md, copied with it.
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  const skillText = read(skill)
  const afterReview = read(path.join(path.dirname(skill), 'after-review.md'))
  // By meaning rather than sentence (#1596: #1524's rewording broke a literal): one of its steps submits the work with
  // `hive_submit`, which takes the card to Review, and one finishes it as Done by reporting the merge commit with
  // `hive_report_merge`, both through the intent tools rather than a column move.
  const skillSteps = `${skillText}\n${afterReview}`.split('\n')
  const submitsToReview = skillSteps.some((l) => l.includes('`hive_submit`') && /\bReview\b/.test(l))
  const doneOnceMerged = skillSteps.some((l) => /\bDone\b/.test(l) && l.includes('`hive_report_merge`') && /\bmerge commit\b/.test(l))
  check('…which says Review when the work is done, and Done once merged', submitsToReview && doneOnceMerged, JSON.stringify({ submitsToReview, doneOnceMerged, start: skillText.slice(0, 200) }))

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
