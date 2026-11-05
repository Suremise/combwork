// The board's stage model and names (#1417, SPEC §16.5.2, OP-1, OP-30): the board's column headers read Active and
// Approved while the Agent API keeps the ids doing and passed; workflow:stages gives the stages a Pair (Combwork merges), a
// No review and a None project produce; a rename through the Assistant's settings tool (cw_update_setting's route)
// shows in the project's status, keeps the ruleset a card starts under, and workflow:check says it applies at once; a
// refused rename gives its reason; and a field of `workflow` written by hand into project.json survives a save.
// Screenshots of the board's renamed columns in both themes, in English, German, Polish and Chinese. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR (the Assistant is the fake Claude Code).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47856))
const userData = path.join(lib.WORK, 'stagenames-profile')
const ws = path.join(lib.WORK, 'stagenames-ws')
const claudeHome = path.join(lib.WORK, 'stagenames-claude-home')
const pair = path.join(ws, 'pair')
const solo = path.join(ws, 'solo')
const notes = path.join(ws, 'notes')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** §16.6.3's Pair (Combwork merges) at P7's values, as project.json keeps it: G15 On, so the start's one-time G15 step (#1445) leaves it as it is. */
const PAIR = { review: 'agent', reviewers: 1, noSelfReview: true, preChecks: [], sameness: 'change', finish: 'combworkMerges', style: 'merge', target: 'main', strict: false, mergeChecks: [], mergeInstall: 'onManifestChange', okBefore: { mode: 'never', labels: [] }, folder: 'slots', identity: null, stopOwnRuns: true, dependenciesDone: true, slotsUpToDate: true, sharedFolderWarning: false, excluded: ['node_modules', '.venv'], commands: {} }

/** A project's project.json, as Combwork keeps it, with `workflow` as given. */
function projectJson(dir, platform, workflow) {
  fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform, agents: [], ...(workflow ? { workflow } : {}) }))
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(pair, { 'a.txt': 'one\n', '.gitignore': '.combwork/\n' })
  lib.gitProject(solo, { 'b.txt': 'two\n', '.gitignore': '.combwork/\n' })
  fs.mkdirSync(notes, { recursive: true })
  fs.writeFileSync(path.join(notes, 'plan.md'), '# Plan\n')
  // Pair (Combwork merges), with a field written by hand that no writer of this version sets: it must survive a save.
  projectJson(pair, 'git', { platform: 'git', preset: 'pair', options: PAIR, handWritten: { by: 'a later Combwork' } })
  // No review: Committed is done, everyone in the project folder.
  projectJson(solo, 'git', { platform: 'git', preset: null, options: { review: 'none', finish: 'committed', folder: 'project' } })
  // None: no version control.
  projectJson(notes, 'none', { platform: 'none', preset: null, options: {} })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), pair.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  cfg.settings.assistant = { ...cfg.settings.assistant, changeSettings: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const api = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(pair, '.combwork', 'project.json'), 'utf8')).workflow

    // --- workflow:stages for the three projects (§16.5.2), in board order, Merging in Approved.
    const ids = async (p) => (await inv('workflow:stages', p))?.stages.map((s) => `${s.id}:${s.category}`).join(' ')
    check('Pair (Combwork merges): every stage, Merging in Approved', (await ids(pair)) === 'hold:hold todo:todo active:doing review:review approved:passed merging:passed done:done', await ids(pair))
    check('No review (Committed is done): On Hold, Todo, Active and Done', (await ids(solo)) === 'hold:hold todo:todo active:doing done:done', await ids(solo))
    check('None with no review: On Hold, Todo, Active and Done', (await ids(notes)) === 'hold:hold todo:todo active:doing done:done', await ids(notes))
    check('no names of its own yet', JSON.stringify((await inv('workflow:stages', pair)).names) === '{}')

    // --- The board's column headers read Active and Approved; the ids stay.
    const cards = {}
    for (const [title, column] of [['Being built', 'doing'], ['Passed review', 'passed'], ['Next up', 'todo']]) {
      // Made in its column (a move into Approved would go through the rules).
      const c = await inv('tasks:create', { title, project: 'pair', ...(column === 'passed' ? { column } : {}) })
      if (column === 'doing') await inv('tasks:update', c.number, { column })
      cards[column] = c.number
    }
    await page.getByRole('button', { name: 'Task Board' }).click()
    const header = (id) => page.locator(`.board-column[data-column="${id}"] .board-column-label`)
    // As written (the header shows it in capitals with CSS).
    const headerText = async (id) => ((await header(id).count()) ? await header(id).textContent() : '')
    check('the doing column reads Active', !!(await lib.until(async () => (await header('doing').count()) === 1 && (await headerText('doing')).includes('Active'), HUNG_MS)), await headerText('doing'))
    check('the passed column reads Approved', (await headerText('passed')).includes('Approved'), await headerText('passed'))
    const headers = (await page.locator('.board-column-label').allTextContents()).join(' | ')
    check('no column says Doing or Passed', !/\bDoing\b|\bPassed\b/.test(headers), headers)

    // The Assistant's own token, as its hive tools use it (it starts as the fake Claude Code).
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    const assistantLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
    await lib.until(async () => {
      const s = await assistantLive()
      if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
      return s?.status === 'ready'
    }, HUNG_MS)
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const token = (await lib.until(() => fs.existsSync(tokenFile), HUNG_MS)) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token : null
    check('the Assistant has its token', !!token)

    // Agents read the ids, as before (cw_list_tasks' route).
    const listed = await api(token, 'GET', '/v1/tasks?project=pair')
    const listedCards = Array.isArray(listed.body) ? listed.body : (listed.body?.tasks ?? [])
    check("the Agent API's cards keep the ids doing and passed", listed.status === 200 && listedCards.find((c) => c.number === cards.doing)?.column === 'doing' && listedCards.find((c) => c.number === cards.passed)?.column === 'passed', JSON.stringify(listedCards.map((c) => [c.number, c.column])))

    // --- A rename through the settings tool's route (cw_update_setting): applies at once, keeps the ruleset.
    const startedRuleset = async (n) => (await inv('tasks:facts', n)).find((f) => f.kind === 'Started')?.ruleset ?? null
    const before = await lib.until(() => startedRuleset(cards.doing), HUNG_MS)
    check('a card started before the rename has its ruleset', !!before, JSON.stringify(await inv('tasks:facts', cards.doing)))
    const renameCheck = await inv('workflow:check', pair, { preset: 'pair', options: { ...PAIR, stageNames: { active: 'Building', merging: 'In the queue' } } })
    check('workflow:check says a rename alone applies at once, with no card or lane keeping old rules', renameCheck.appliesNow === true && JSON.stringify(renameCheck.changed) === '["stageNames"]' && renameCheck.inFlight.length === 0 && renameCheck.lanes.length === 0, JSON.stringify(renameCheck))
    const renamed = await api(token, 'PATCH', '/v1/settings/project.workflow.stageNames', { value: { active: ' Building ', merging: 'In the queue' }, project: 'pair' })
    check('the Assistant renames Active and Merging', renamed.status === 200, JSON.stringify(renamed))
    const status = await api(token, 'GET', '/v1/projects/pair')
    const stages = status.body?.workflow?.stages ?? []
    check("the project's status lists its stages with their names, trimmed, by id and category", JSON.stringify(stages.map((s) => [s.id, s.category, s.name])) === JSON.stringify([['hold', 'hold', 'On Hold'], ['todo', 'todo', 'Todo'], ['active', 'doing', 'Building'], ['review', 'review', 'Review'], ['approved', 'passed', 'Approved'], ['merging', 'passed', 'In the queue'], ['done', 'done', 'Done']]), JSON.stringify(status.body?.workflow).slice(0, 600))
    check('workflow:stages has the names', JSON.stringify((await inv('workflow:stages', pair)).names) === JSON.stringify({ active: 'Building', merging: 'In the queue' }))
    const next = await inv('tasks:create', { title: 'After the rename', project: 'pair' })
    await inv('tasks:update', next.number, { column: 'doing' })
    const after = await lib.until(() => startedRuleset(next.number), HUNG_MS)
    check('a card started after the rename starts under the same ruleset (names are not rules)', !!after && after === before, JSON.stringify({ before, after }))

    // --- A refused rename gives its reason; nothing changes.
    const dup = await api(token, 'PATCH', '/v1/settings/project.workflow.stageNames', { value: { active: 'review' }, project: 'pair' })
    check('a name another stage has is refused with its reason', dup.status === 400 && /The name of Active is already another stage’s name\./.test(dup.body?.error ?? ''), JSON.stringify(dup))
    const long = await api(token, 'PATCH', '/v1/settings/project.workflow.stageNames', { value: { active: 'A name that is far too long for a column' }, project: 'pair' })
    check('a name over 24 characters is refused with its reason', long.status === 400 && /longer than 24 characters/.test(long.body?.error ?? ''), JSON.stringify(long))
    const unknown = await api(token, 'PATCH', '/v1/settings/project.workflow.stageNames', { value: { building: 'Building' }, project: 'pair' })
    check('a stage that does not exist is refused, saying what it takes', unknown.status === 400 && /an object of stage id/.test(unknown.body?.error ?? ''), JSON.stringify(unknown))
    check('…and the names stay as they were', JSON.stringify(onDisk().options.stageNames) === JSON.stringify({ active: 'Building', merging: 'In the queue' }), JSON.stringify(onDisk()))
    const refusedSave = await inv('workflow:setOptions', pair, { preset: 'pair', options: { ...PAIR, stageNames: { review: 'Ship\tit' } } }).then(
      () => null,
      (e) => String(e.message ?? e)
    )
    check('the window’s save refuses a name with a tab, with its reason', /The name of Review has a character that can’t be shown/.test(refusedSave ?? ''), refusedSave)

    // --- A hand-written field of `workflow` survives the tool's write and a form save.
    check('the hand-written field survived the rename', JSON.stringify(onDisk().handWritten) === JSON.stringify({ by: 'a later Combwork' }), JSON.stringify(onDisk()))
    await inv('workflow:setOptions', pair, { preset: 'pair', options: { ...PAIR, strict: true, stageNames: { active: 'Building', merging: 'In the queue' } } })
    check('…and a save of the options', onDisk().options.strict === true && JSON.stringify(onDisk().handWritten) === JSON.stringify({ by: 'a later Combwork' }), JSON.stringify(onDisk()))
    await inv('workflow:setOptions', pair, { preset: 'pair', options: { ...PAIR, stageNames: { active: 'Building', merging: 'In the queue' } } })
    await inv('session:stop', home, 'assistant')

    // --- Screenshots: the board's renamed category columns, both themes, in English and the languages whose word changed.
    const boardShot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `stagenames-board-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    await page.getByRole('button', { name: 'Task Board' }).click().catch(() => undefined)
    await header('doing').waitFor({ timeout: HUNG_MS })
    await boardShot('en')
    const base = (await inv('app:info')).language
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
    const words = { de: ['In Arbeit', 'Genehmigt'], pl: ['Aktywne', 'Zatwierdzone'], 'zh-CN': ['进行中', '已批准'] }
    for (const [code, [active, approved]] of Object.entries(words)) {
      const dir = path.join(lib.ROOT, 'locales', code)
      await speak({ ...base, code, locale: code, messages: Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))) })
      check(`the columns read ${active} and ${approved} (${code})`, !!(await lib.until(async () => (await headerText('doing')).includes(active) && (await headerText('passed')).includes(approved), HUNG_MS)), `${await headerText('doing')} / ${await headerText('passed')}`)
      await boardShot(code)
    }
    await speak(base)
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    // What the window showed then, for whoever reads the failure.
    await app
      .firstWindow()
      .then((p) => p.screenshot({ path: path.join(lib.WORK, 'stagenames-failed.png') }))
      .catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nstagenames: all checks passed')
  process.exit(failed ? 1 : 0)
})()
