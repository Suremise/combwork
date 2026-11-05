// A card's decisions (#357): the card dialog pins them above the comments, newest last, each saying who recorded it;
// the user adds one (Ctrl+Enter too), changes and removes one (the history keeps what it said); one recorded after work
// on the card started is marked "new since start"; one recorded through the Agent API is the user's decision, recorded
// by the caller, and the API can't change or remove one. The card's tile counts them, with a tooltip. GET /v1/tasks/{n}
// lists them first. Closing the card while a decision is being changed asks first, and waits for one being saved. An agent
// working on the card hears of a decision recorded meanwhile in its next reply, also from a tool that isn't the board's
// (its own token; the real hive MCP server adds the line). The dialog's Save keeps everything typed in it (#432): a
// decision being written is recorded as the user's, a comment posted, both once each, a change to a decision saved,
// and a failed save leaves the dialog open with the words, also through Move to Active, whose Try Again writes nothing
// twice; a decision changed to nothing is refused; Add Decision and Comment stand out while their box has text,
// saying Save adds them too. The agent runs the fake Claude Code. Both themes. Dev build, throwaway profile, workspace
// and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'decisions-profile')
const ws = path.join(lib.WORK, 'decisions-ws')
const claudeHome = path.join(lib.WORK, 'decisions-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47888))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = (fn, ms = 10000) => lib.until(fn, ms)
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const shot = async (name) => {
    await page.screenshot({ path: path.join(lib.WORK, `decisions-${name}-dark.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await lib.sleep(200)
    await page.screenshot({ path: path.join(lib.WORK, `decisions-${name}-light.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }

  const n = (await inv('tasks:create', { title: 'Login form errors', project: 'alpha', description: 'Show the validation errors.' })).number
  await inv('tasks:comment', n, 'Started looking at the form.')
  await page.getByRole('button', { name: 'Task Board' }).click()
  const tile = page.locator(`.task-card[data-task="${n}"]`)
  await until(async () => (await tile.count()) === 1, HUNG_MS)
  check('a card without decisions shows no marker', (await tile.locator('.task-decision-count').count()) === 0)

  // The user records one in the dialog.
  await tile.click()
  const dialog = lib.cardDialog(page, await lib.cardLabel(inv, n))
  await until(async () => (await dialog.count()) === 1, 5000)
  const section = dialog.locator('.task-decisions')
  const above = await page.evaluate(() => {
    const d = document.querySelector('.dialog .task-decisions')
    const c = document.querySelector('.dialog .task-comment')
    return !!d && !!c && !!(d.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  check('the dialog has Decisions (0), above the comments', /Decisions \(0\)/i.test(await section.innerText()) && above, (await section.innerText()).slice(0, 80))
  await dialog.getByLabel('New decision').fill('Keep the form at login.html; no new page.')
  await dialog.getByRole('button', { name: 'Add Decision' }).click()
  const items = section.locator('.task-decision')
  check('Add Decision records it', !!(await until(async () => (await items.count()) === 1, 5000)) && /Keep the form at login\.html/.test(await items.first().innerText()) && /Decided by you/.test(await items.first().innerText()) && !/recorded by/.test(await items.first().innerText()))
  check('…decided by the user, recorded by You, in the history', !!(await until(async () => {
    const c = await card(n)
    return c.decisions?.[0]?.decidedBy === 'user' && c.decisions[0].recordedBy === 'You' && c.history.at(-1).what === 'Recorded a decision: "Keep the form at login.html; no new page."'
  }, 5000)))
  check('…and the field is empty again', (await dialog.getByLabel('New decision').inputValue()) === '')
  await page.keyboard.press('Escape')
  await until(async () => (await dialog.count()) === 0, 5000)

  // Work on it starts; an agent's (here the Agent API's) record comes after: "new since start", recorded by the caller.
  await inv('tasks:update', n, { column: 'doing' })
  await lib.sleep(20)
  const recorded = await api('PATCH', `/v1/tasks/${n}`, { decision: 'Show each error under its own field, not in a banner.', reply: 'short' })
  check('the Agent API records a decision', recorded.status === 200 && JSON.stringify(recorded.body).includes('Recorded a decision'), JSON.stringify(recorded))
  const read = await api('GET', `/v1/tasks/${n}`)
  check('GET /v1/tasks/{n} lists the decisions first, without ids', JSON.stringify(Object.keys(read.body).slice(0, 3)) === JSON.stringify(['number', 'title', 'decisions']) && read.body.decisions.length === 2 && read.body.decisions.every((d) => !('id' in d) && d.decidedBy === 'user') && read.body.decisions[1].recordedBy === 'Agent API', JSON.stringify(Object.keys(read.body).slice(0, 4)))
  check('the tile counts them', !!(await until(async () => (await tile.locator('.task-decision-count').innerText().catch(() => '')).trim() === '2', 5000)))
  await tile.locator('.task-decision-count').hover()
  check('…with a tooltip that lists them', !!(await until(async () => /Decisions: 2\. Keep the form/.test(await page.locator('.tip').innerText().catch(() => '')), HUNG_MS)))

  await tile.click()
  await until(async () => (await dialog.count()) === 1, 5000)
  check('newest last, with who recorded it', /Show each error/.test(await items.nth(1).innerText()) && /recorded by Agent API/.test(await items.nth(1).innerText()))
  check('the later one is new since start, the first not', /new since start/.test(await items.nth(1).innerText()) && !/new since start/.test(await items.nth(0).innerText()))
  await shot('dialog')

  // Changing and removing are the user's.
  const id = (await card(n)).decisions[1].id
  check('the Agent API has no way to replace or remove them (an unknown field changes nothing)', (await api('PATCH', `/v1/tasks/${n}`, { decisions: [] })).status === 200 && (await card(n)).decisions.length === 2)
  await items.nth(1).getByRole('button', { name: 'Change this decision' }).click()
  const editor = items.nth(1).getByLabel('Decision')
  await editor.fill('Show each error under its own field.')
  await page.keyboard.press('Control+Enter')
  check('changing one saves it, marked edited', !!(await until(async () => /Show each error under its own field\.\s/.test(await items.nth(1).innerText()) && /edited/.test(await items.nth(1).innerText()), 5000)))
  check('…and the history says what it was', (await card(n)).history.at(-1).what === 'Changed a decision to "Show each error under its own field." (was "Show each error under its own field, not in a banner.")')
  await items.nth(0).getByRole('button', { name: 'Remove this decision' }).click()
  const confirmRemove = page.locator('.dialog', { hasText: 'Remove this decision?' })
  await until(async () => (await confirmRemove.count()) === 1, 5000)
  await confirmRemove.getByRole('button', { name: 'Remove', exact: true }).click()
  check('removing one asks, then removes it', !!(await until(async () => (await items.count()) === 1 && (await card(n)).decisions.length === 1 && (await card(n)).decisions[0].id === id, 5000)))
  check('…and the history keeps its words', (await card(n)).history.at(-1).what === 'Removed a decision: "Keep the form at login.html; no new page."')

  // A decision being written: closing asks before it is lost; Ctrl+Enter adds it.
  await dialog.getByLabel('New decision').fill('Errors in red.')
  await page.keyboard.press('Escape')
  const discard = page.locator('.dialog', { hasText: 'Discard unsaved changes?' })
  check('closing with a decision half-written asks', !!(await until(async () => (await discard.count()) === 1, 5000)) && /the decision you are writing/.test(await discard.innerText()))
  await discard.getByRole('button', { name: 'Keep Editing' }).click()
  await dialog.getByLabel('New decision').focus()
  await page.keyboard.press('Control+Enter')
  check('Ctrl+Enter adds it', !!(await until(async () => (await items.count()) === 2, 5000)))
  await shot('edited')

  // A decision being changed: Escape and Cancel ask first, and Keep Editing keeps the words.
  const changing = items.nth(0)
  await changing.getByRole('button', { name: 'Change this decision' }).click()
  await changing.getByLabel('Decision').fill('Show each error under its field, in red.')
  await page.keyboard.press('Escape')
  check('Escape with a decision being changed asks', !!(await until(async () => (await discard.count()) === 1, 5000)) && /your change to a decision/.test(await discard.innerText()), await discard.innerText().catch(() => ''))
  await discard.getByRole('button', { name: 'Keep Editing' }).click()
  check('…and Keep Editing keeps the words', (await dialog.count()) === 1 && (await changing.getByLabel('Decision').inputValue()) === 'Show each error under its field, in red.')
  await dialog.locator('.dialog-footer').getByRole('button', { name: 'Cancel' }).click()
  check('Cancel asks too', !!(await until(async () => (await discard.count()) === 1, 5000)))
  await discard.getByRole('button', { name: 'Keep Editing' }).click()
  // Saving it slowly: the card can't close until it is saved.
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = 'tasks:editDecision=2500*1'
  })
  await changing.getByRole('button', { name: 'Save' }).click()
  await lib.sleep(300)
  await page.keyboard.press('Escape')
  await lib.sleep(300)
  check('closing waits while a decision is being saved', (await dialog.count()) === 1 && (await discard.count()) === 0)
  check('…which then saves it', !!(await until(async () => (await card(n)).decisions[0].text === 'Show each error under its field, in red.', 8000)))
  await app.evaluate(() => {
    delete process.env.CW_TEST_SLOW_IPC
  })
  await until(async () => (await changing.getByLabel('Decision').count()) === 0, 5000)
  await page.keyboard.press('Escape')
  check('with nothing unsaved, the card closes', !!(await until(async () => (await dialog.count()) === 0, 5000)))

  // --- Save keeps everything typed in the dialog (#432), on a card of its own.
  const m = (await inv('tasks:create', { title: 'Password reset', project: 'alpha' })).number
  const mTile = page.locator(`.task-card[data-task="${m}"]`)
  const mDialog = lib.cardDialog(page, await lib.cardLabel(inv, m))
  const open = async () => {
    await until(async () => (await mTile.count()) === 1, 5000)
    await mTile.click()
    await until(async () => (await mDialog.count()) === 1, 5000)
  }
  const saveAndClose = async () => {
    await mDialog.locator('.dialog-footer').getByRole('button', { name: 'Save', exact: true }).click()
    return !!(await until(async () => (await mDialog.count()) === 0, 8000))
  }
  const addDecision = mDialog.getByRole('button', { name: 'Add Decision' })
  const postComment = mDialog.getByRole('button', { name: 'Comment', exact: true })
  await open()
  check('Add Decision and Comment are plain, with no hint, while their boxes are empty', !(await addDecision.getAttribute('class')).includes('primary') && !(await postComment.getAttribute('class')).includes('primary') && (await mDialog.getByText(/Save (adds|posts) it too/).count()) === 0)
  await mDialog.getByLabel('New decision').fill('Reset links last one hour.')
  await mDialog.getByLabel('New comment').fill('Checked the mail template.')
  check('…and stand out once there is text, each saying Save adds it too', (await addDecision.getAttribute('class')).includes('primary') && (await postComment.getAttribute('class')).includes('primary') && (await mDialog.getByText('Save adds it too').count()) === 1 && (await mDialog.getByText('Save posts it too').count()) === 1)
  await mDialog.getByLabel('New decision').scrollIntoViewIfNeeded()
  await shot('save-drafts')
  check('Save with a decision and a comment being written closes the card', await saveAndClose())
  const after = await card(m)
  check('…recording the decision as the user\'s, once', after.decisions?.length === 1 && after.decisions[0].text === 'Reset links last one hour.' && after.decisions[0].decidedBy === 'user' && after.decisions[0].recordedBy === 'You', JSON.stringify(after.decisions))
  check('…and posting the comment, once', after.comments.filter((c) => c.text === 'Checked the mail template.').length === 1 && after.comments.length === 1, JSON.stringify(after.comments))

  // A decision alone, then a comment alone.
  await open()
  await mDialog.getByLabel('New decision').fill('Links work once.')
  check('Save with only a decision being written records it', (await saveAndClose()) && (await card(m)).decisions.map((d) => d.text).join('|') === 'Reset links last one hour.|Links work once.' && (await card(m)).comments.length === 1)
  await open()
  await mDialog.getByLabel('New comment').fill('Template updated.')
  check('Save with only a comment being written posts it', (await saveAndClose()) && (await card(m)).comments.length === 2 && (await card(m)).decisions.length === 2)

  // A change to a decision, saved by the dialog's Save too.
  await open()
  const mItems = mDialog.locator('.task-decision')
  await mItems.nth(1).getByRole('button', { name: 'Change this decision' }).click()
  await mItems.nth(1).getByLabel('Decision').fill('Links work once, for one hour.')
  check('Save with a decision being changed saves the change', (await saveAndClose()) && (await card(m)).decisions[1].text === 'Links work once, for one hour.' && (await card(m)).decisions.length === 2)

  // A failed save: the dialog stays open with the words, nothing recorded; Save again records it once.
  await open()
  await mDialog.getByLabel('New decision').fill('Expired links say so.')
  await app.evaluate(() => {
    process.env.CW_TEST_FAIL_IPC = 'tasks:update*1'
  })
  await mDialog.locator('.dialog-footer').getByRole('button', { name: 'Save', exact: true }).click()
  await until(async () => (await mDialog.locator('.dialog-error, .field-error, .error').count()) > 0, 5000)
  check('a failed save leaves the dialog open, the decision still typed, nothing recorded', (await mDialog.count()) === 1 && (await mDialog.getByLabel('New decision').inputValue()) === 'Expired links say so.' && (await card(m)).decisions.length === 2)
  await app.evaluate(() => {
    delete process.env.CW_TEST_FAIL_IPC
  })
  check('…and Save again records it, once', (await saveAndClose()) && (await card(m)).decisions.filter((d) => d.text === 'Expired links say so.').length === 1)

  // Ctrl+Enter in the decision box adds just the decision: a comment being written stays in its box.
  await open()
  await mDialog.getByLabel('New comment').fill('Not yet.')
  await mDialog.getByLabel('New decision').fill('Log each reset.')
  await mDialog.getByLabel('New decision').press('Control+Enter')
  check('Ctrl+Enter in the decision box adds only the decision', !!(await until(async () => (await card(m)).decisions.length === 4, 5000)) && (await card(m)).comments.length === 2 && (await mDialog.getByLabel('New comment').inputValue()) === 'Not yet.')
  await mDialog.getByLabel('New comment').fill('')

  // A decision changed to nothing: Save refuses it, saying why, and keeps the editor; nothing changes.
  const before = JSON.stringify((await card(m)).decisions)
  await mItems.nth(0).getByRole('button', { name: 'Change this decision' }).click()
  await mItems.nth(0).getByLabel('Decision').fill('   ')
  await mDialog.locator('.dialog-footer').getByRole('button', { name: 'Save', exact: true }).click()
  check('Save with a decision changed to nothing refuses it, says why and keeps the editor', !!(await until(async () => /A decision can't be empty/.test(await mDialog.innerText().catch(() => '')), 5000)) && (await mDialog.count()) === 1 && (await mItems.nth(0).getByLabel('Decision').count()) === 1 && JSON.stringify((await card(m)).decisions) === before)
  await mItems.nth(0).getByRole('button', { name: 'Cancel' }).click()
  await page.keyboard.press('Escape')
  await until(async () => (await mDialog.count()) === 0, 5000)

  // Save into Active goes through Move to Active, which saves the drafts first; its Try Again writes nothing twice.
  const moveDialog = page.locator('.dialog', { hasText: `Move ${await lib.cardLabel(inv, m)} to Active` })
  const viaMoveToDoing = async (fail) => {
    await mDialog.locator('select').nth(2).selectOption('doing')
    await mDialog.locator('.dialog-footer').getByRole('button', { name: 'Save', exact: true }).click()
    if (!(await until(async () => (await moveDialog.count()) === 1, 5000))) {
      await page.screenshot({ path: path.join(lib.WORK, 'decisions-move-missing.png') })
      return false
    }
    // The function gets Electron's module first, then the argument.
    await app.evaluate((_e, f) => {
      process.env.CW_TEST_FAIL_IPC = f
    }, fail)
    await moveDialog.locator('.dialog-footer .btn.primary').click()
    const refused = !!(await until(async () => (await moveDialog.locator('.dialog-footer .btn.primary').innerText({ timeout: 1000 }).catch(() => '')).includes('Try Again'), 8000))
    if (!refused) await page.screenshot({ path: path.join(lib.WORK, 'decisions-move-nofail.png') })
    await app.evaluate(() => {
      delete process.env.CW_TEST_FAIL_IPC
    })
    await moveDialog.locator('.dialog-footer .btn.primary').click()
    return refused && !!(await until(async () => (await moveDialog.count()) === 0 && (await mDialog.count()) === 0 && (await card(m)).column === 'doing', 8000))
  }
  const decisionsBefore = (await card(m)).decisions.length
  const commentsBefore = (await card(m)).comments.length
  await open()
  await mDialog.getByLabel('New decision').fill('Reset mails name the app.')
  await mDialog.getByLabel('New comment').fill('Moving it on.')
  check('Move to Active with both drafts, the comment failing once: Try Again moves it', await viaMoveToDoing('tasks:comment*1'))
  const doing = await card(m)
  check('…with the decision recorded once and the comment posted once', doing.decisions.length === decisionsBefore + 1 && doing.decisions.filter((d) => d.text === 'Reset mails name the app.').length === 1 && doing.comments.filter((c) => c.text === 'Moving it on.').length === 1 && doing.comments.length === commentsBefore + 1, JSON.stringify({ decisions: doing.decisions.map((d) => d.text), comments: doing.comments.map((c) => c.text) }))
  await inv('tasks:update', m, { column: 'todo' })
  // The board has it in Todo before the card opens (the dialog takes its fields from the board as it opens).
  await until(async () => (await page.locator(`[data-column="todo"] .task-card[data-task="${m}"]`).count()) === 1, 5000)
  await open()
  await mDialog.getByLabel('New comment').fill('Second try.')
  // The move itself fails once (after the comment was posted): Try Again posts nothing again. The window's moves go
  // through tasks:move since #1275 (#1333).
  check('Move to Active with a comment, the move failing once: Try Again moves it', await viaMoveToDoing('tasks:move*1'))
  check('…with the comment posted once', (await card(m)).comments.filter((c) => c.text === 'Second try.').length === 1 && (await card(m)).decisions.length === decisionsBefore + 1)

  // An agent on the card: its next reply flags a decision recorded since it read the card, whatever tool it called.
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  await inv('session:start', alpha, { agentId: coder.id })
  check('Coder starts', !!(await until(async () => (await inv('session:live')).some((x) => x.agentId === coder.id && ['ready', 'waiting'].includes(x.status)), 20000)))
  const launch = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)
  const coderToken = launch.token
  // HI-2262: its session has the token's file, never the token in its environment (an `env` listing printed it).
  check("Coder's session has CW_API_TOKEN_FILE and its token, never CW_API_TOKEN", !!launch.env?.CW_API_TOKEN_FILE && /^[0-9a-f]{64}$/.test(coderToken ?? '') && !('CW_API_TOKEN' in (launch.env ?? {})), JSON.stringify(Object.keys(launch.env ?? {})))
  let oldNotice = false
  const asCoder = async (p, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${coderToken}`, 'X-Combwork-Workspace': encodeURIComponent(ws), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const notice = res.headers.get('x-combwork-notice')
    // HI-2588: renamed outright: the name before 1.1 is never sent.
    if (res.headers.has('x-hive-notice')) oldNotice = true
    return { status: res.status, notice: notice ? decodeURIComponent(notice) : null }
  }
  await inv('tasks:update', n, { agent: coder.id })
  check("the agent's read of its card has no flag", (await asCoder(`/v1/tasks/${n}`)).notice === null)
  await lib.sleep(20)
  await inv('tasks:update', n, { decision: 'Errors stay on screen until fixed.' })
  // Notices name the card by its key with the number the tools take (#1219): its own key, from the board.
  const named = `${(await card(n)).key}`
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(named), named)
  const status = await asCoder('/v1/projects/alpha')
  check('a decision recorded since: its next reply, from a tool that is not the board, flags it', status.status === 200 && status.notice === `[CW] ${named} has 1 new decision since you last read it: read the card (cw_read_task) at your next checkpoint.`, JSON.stringify(status))
  // Through the real hive MCP server, as the agent's tools see it: the reply ends with the line.
  const viaMcp = JSON.parse(
    execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cw_project_status', arguments: {} } }) + '\n',
      env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${PORT}`, CW_WORKSPACE: ws, CW_API_TOKEN_FILE: lib.tokenFile(coderToken), CW_PROJECT: 'alpha', CW_AGENT_ID: coder.id }),
      timeout: 60000
    })
      .toString()
      .split('\n')[0]
  ).result
  check('…and cw_project_status ends with it', !viaMcp.isError && viaMcp.content[0].text.endsWith(`\n[CW] ${named} has 1 new decision since you last read it: read the card (cw_read_task) at your next checkpoint.`), viaMcp.content?.[0]?.text?.slice(-200))
  await asCoder(`/v1/tasks/${n}`)
  // Its read in full is recorded as a fact (#1216): the decision generation that reply gave it, the card's newest.
  const received = await until(async () => {
    const facts = await inv('tasks:facts', n)
    const newest = Math.max(0, ...facts.filter((f) => f.kind === 'Decision').map((f) => f.data.generation))
    const got = facts.filter((f) => f.kind === 'DecisionsReceived' && f.data.agent === coder.id).at(-1)
    return got && newest > 0 && got.data.generation === newest ? got : null
  }, 10000)
  check('the read in full records DecisionsReceived at the generation the reply gave (#1216)', !!received, JSON.stringify(received))
  check('read in full, it is no longer flagged', (await asCoder('/v1/projects/alpha')).notice === null)
  // The call that moves the card on (to Review) still hears of a decision it hasn't read: the card was its own when the
  // call began.
  await lib.sleep(20)
  await inv('tasks:update', n, { decision: 'One message per field.' })
  const moved = await asCoder(`/v1/tasks/${n}`, 'PATCH', { column: 'review', reply: 'short' })
  check('moving the card to Review with a decision unread: that reply flags it', moved.status === 200 && moved.notice === `[CW] ${named} has 1 new decision since you last read it: read the card (cw_read_task) at your next checkpoint.`, JSON.stringify(moved))
  check('…and once out of its hands, its next replies say nothing more', (await asCoder('/v1/projects/alpha')).notice === null)
  check('no reply carried the old X-Hive-Notice header (HI-2588)', !oldNotice)

  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
