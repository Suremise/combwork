// The task board: cards added in the Board view and through the Agent API (as an agent's Combwork tools would), Done kept
// for the user, dragging between columns, column colours (Settings → Board), Start on a new agent (the fake Claude Code gets the card as its prompt),
// a project's Tasks tab, archiving; and Project → Remove Project… (Hide, restored from Settings → Workspace, and
// Delete). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR. Delete sends a small test folder to the
// Recycle Bin.
// Dev build only (#1580): it starts this checkout's Electron itself, and delta's long-named agent is a 0.9 worktree
// agent (agents:testLegacy, refused by a packaged build), for Remove Project's table of names and branches (#1316).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'board-profile')
const ws = path.join(lib.WORK, 'board-ws')
const claudeHome = path.join(lib.WORK, 'board-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47897))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  // Trusted already: an agent started from the board has no terminal on screen, so its trust question wraps narrowly.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  for (const p of ['beta', 'gamma']) fs.mkdirSync(path.join(ws, p), { recursive: true })
  // delta is a repository: Remove Project lists an agent's worktree of it (#1316).
  lib.gitProject(path.join(ws, 'delta'))
  fs.writeFileSync(path.join(ws, 'gamma', 'notes.txt'), 'delete me')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  // The board's own moves, as before 1.0's rules (#1275): its project has every rule off, where Review isn't a stage, so
  // with the rules enforced the board refuses it (boardgates covers that); turned off, every column is a plain move.
  await inv('advanced:set', 'cw.workflow.enforce', false)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const cards = () => inv('tasks:list')
  const card = async (n) => (await cards()).find((c) => c.number === n)
  const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
  const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
  /**
   * Closes a dialog with Escape and makes sure it went (#429): a busy window can miss the key (pressed while the focus is
   * still moving into the dialog), so it is pressed again while the dialog is still open, a few times at most.
   */
  const escapeCloses = async (d) => {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape')
      // A try's pace, not a bound: not closed within 3 s, Escape is pressed again (the three tries are the bound).
      if (await until(async () => (await d.count()) === 0, 3000)) return true
    }
    return false
  }

  // The Board view, and a card added there.
  await page.getByRole('button', { name: 'Task Board' }).click()
  // With the rules not enforced every category shows (#1420), as before 1.0.
  check('the Board shows six columns', !!(await until(async () => (await page.locator('.board-column').count()) === 6, 5000)))
  const dialog = page.locator('.dialog', { hasText: 'New Card' })
  await page.getByRole('button', { name: 'New Card', exact: true }).click()
  // Escape as soon as the title has the keyboard (polled often): the first New Card's first render answered Escape with
  // a view made before its fields opened, asking to discard an empty card, unless something else drew it again (#548).
  check('a new card’s title takes the keyboard', !!(await lib.until(() => page.evaluate(() => !!document.activeElement?.classList.contains('task-title-input')), 5000, 20)))
  const escaped = await escapeCloses(dialog)
  const escapeState = escaped ? '' : await page.evaluate(() => JSON.stringify({ dialogs: [...document.querySelectorAll('.dialog')].map((d) => d.querySelector('.dialog-header')?.textContent?.trim()), active: `${document.activeElement?.tagName}.${document.activeElement?.className}` }))
  if (!escaped) await page.screenshot({ path: path.join(lib.WORK, 'board-escape.png') })
  check('Escape closes the new card dialog', escaped, escapeState)
  // That focus comes on a short timer, which a busy window runs late (#229): hold the dialog's short timers until the
  // description has the keyboard, then run them just before the text arrives. It still lands in the description.
  await page.evaluate(() => {
    const orig = window.setTimeout
    const held = (window.__held = [])
    window.setTimeout = (fn, ms, ...a) => (ms <= 100 ? (held.push(() => fn(...a)), 0) : orig(fn, ms, ...a))
    const onFocus = (e) => {
      if (!e.target.classList?.contains('task-description-input')) return
      document.removeEventListener('focusin', onFocus)
      window.setTimeout = orig
      orig(() => held.splice(0).forEach((f) => f()), 0)
    }
    document.addEventListener('focusin', onFocus)
  })
  await page.getByRole('button', { name: 'New Card', exact: true }).click()
  await dialog.locator('.task-title-input').fill('Add a greeting')
  await dialog.locator('select').first().selectOption('alpha')
  const desc = dialog.locator('.task-description-input')
  await desc.fill('Write `hello()` in a.ts and test it.')
  await until(() => page.evaluate(() => window.__held.length === 0), 5000)
  const typed = { title: await dialog.locator('.task-title-input').inputValue(), description: await desc.inputValue() }
  check('a late title focus leaves the description’s text in the description', typed.title === 'Add a greeting' && typed.description.startsWith('Write'), JSON.stringify(typed))
  await dialog.getByRole('button', { name: 'Add Card' }).click()
  check('a new card shows in Todo', !!(await until(async () => (await column('Todo').locator('.task-card[data-task="1"]').count()) === 1, 5000)))
  const c1 = await card(1)
  check('with its project and description', c1?.project === 'alpha' && c1.description.includes('hello()') && c1.createdBy === 'You', JSON.stringify(c1))

  // As an agent: add a card, move it to Done and back out of it, then to Review with a comment.
  const made = await api('POST', '/v1/tasks', { title: 'Follow-up: docs', project: 'alpha', labels: ['docs'] })
  check('an agent adds a card through the Agent API', made.status === 200 && made.body.number === 2, JSON.stringify(made))
  check('it shows on the board', !!(await until(async () => (await tile(2).count()) === 1, 5000)))
  const done = await api('PATCH', '/v1/tasks/2', { column: 'done' })
  check('an Agent API caller moves a card to Done', done.status === 200 && done.body.column === 'done', JSON.stringify(done))
  check('it shows in Done', !!(await until(async () => (await column('Done').locator('.task-card[data-task="2"]').count()) === 1, 5000)))
  const out = await api('PATCH', '/v1/tasks/2', { column: 'todo' })
  check('and back out of Done, with no approval step', out.status === 200 && out.body.column === 'todo', JSON.stringify(out))
  check('both moves are in its history', JSON.stringify((await card(2)).history.filter((h) => h.what.startsWith('Moved to')).map((h) => [h.by, h.what])) === JSON.stringify([['Agent API', 'Moved to Done'], ['Agent API', 'Moved to Todo']]), JSON.stringify((await card(2)).history))
  const review = await api('PATCH', '/v1/tasks/2', { column: 'review', comment: 'Docs drafted.' })
  check('an agent moves it to Review with a comment', review.status === 200 && review.body.column === 'review' && review.body.comments.length === 1, JSON.stringify(review.body))
  const badge = page.locator('.activity-btn[aria-label="Task Board"] .activity-badge')
  // Its count is of cards waiting for you (#1276: For you), not Review's (the board sidebar's Waiting for review has those).
  check("the activity bar doesn't count cards waiting for review", (await badge.count()) === 0)
  const start = await api('POST', '/v1/tasks/1/start', {})
  check('only the Assistant starts cards through the API', start.status === 403, JSON.stringify(start))

  // As an agent: put cards in order (a list in one call, then one card), and the board follows.
  const todoOrder = () => column('Todo').locator('.task-card').evaluateAll((els) => els.map((e) => Number(e.dataset.task)))
  const rA = (await api('POST', '/v1/tasks', { title: 'Order A', project: 'alpha' })).body.number
  const rB = (await api('POST', '/v1/tasks', { title: 'Order B', project: 'alpha' })).body.number
  await until(async () => (await todoOrder()).length === 3, 5000)
  const reorder = await api('POST', '/v1/tasks/reorder', { column: 'todo', cards: [rB, rA] })
  check('an agent puts cards in order in one call', reorder.status === 200 && reorder.body.map((c) => c.number).join() === [rB, rA, 1].join(), JSON.stringify(reorder.body?.map?.((c) => c.number) ?? reorder))
  check('the board shows the new order', !!(await until(async () => (await todoOrder()).join() === [rB, rA, 1].join(), 5000)), (await todoOrder()).join())
  // A was 2nd already: only B moved, so only B's history says so.
  check('the history says where it went', (await card(rB))?.history.at(-1)?.what === 'Moved to the top of Todo' && (await card(rA))?.history.length === 1, JSON.stringify([(await card(rB))?.history, (await card(rA))?.history]))
  const bottom = await api('PATCH', `/v1/tasks/${rB}`, { position: 'bottom' })
  check('an agent moves one card to the bottom', bottom.status === 200 && !!(await until(async () => (await todoOrder()).join() === [rA, 1, rB].join(), 5000)), (await todoOrder()).join())
  const wrong = await api('PATCH', `/v1/tasks/${rA}`, { before: 2 })
  check("before a card in another column is refused", wrong.status === 400 && /in Review, not in Todo/.test(wrong.body?.error), JSON.stringify(wrong))
  const mixed = await api('POST', '/v1/tasks/reorder', { column: 'todo', cards: [rA, 2] })
  const doneOrder = await api('POST', '/v1/tasks/reorder', { column: 'done', cards: [rA] })
  check('a list with a card from another column, or for Done, is refused', mixed.status === 400 && doneOrder.status === 403, JSON.stringify([mixed, doneOrder]))
  for (const n of [rA, rB]) await inv('tasks:delete', n)

  // Dragging a card to another column. Each drag starts once the board draws the card where the step before left it
  // (#682: under load the board was still redrawing after the deletions above, and both drags missed). A drop shows at
  // once (the card moved, or the Move to Active dialog: no call first), so one not shown within the hung-run bound
  // missed: logged with what the board showed (a screenshot too), and dragged again, at most 3 times.
  const drawnIn = (label, n) => column(label).locator(`.task-card[data-task="${n}"]`)
  const dragged = async (what, n, label, landed) => {
    for (let drag = 1; drag <= 3; drag++) {
      const t = Date.now()
      await tile(n).dragTo(column(label).locator('.board-column-body'))
      let looks = 0
      const ok = !!(await until(async () => (looks++, await landed()), HUNG_MS))
      if (looks > 1) console.log(`  (${what}, drag ${drag}: ${ok ? 'landed' : 'missed'} after ${Date.now() - t} ms; #${n} is in ${(await card(n))?.column}, drawn in ${JSON.stringify(await page.locator(`.board-column:has(.task-card[data-task="${n}"]) .board-column-label`).allInnerTexts())}, ${await page.locator('.dialog').count()} dialog(s) open)`)
      if (ok) return true
      await page.screenshot({ path: path.join(lib.WORK, `board-drag-${label.toLowerCase()}-${drag}.png`) })
    }
    return false
  }
  const deleted = Date.now()
  let redraws = 0
  check('…and the board draws only #1 again', !!(await until(async () => (redraws++, (await tile(rA).count()) + (await tile(rB).count()) === 0 && (await drawnIn('Todo', 1).count()) === 1), HUNG_MS)))
  if (redraws > 1) console.log(`  (the board drew the deletions ${Date.now() - deleted} ms after they were made)`)
  check('a card drags to another column', await dragged('to Review', 1, 'Review', async () => (await card(1))?.column === 'review'), (await card(1))?.column)
  // Into Active, it asks who works on it first (doingmove has the rest).
  check('…and the board draws it in Review', !!(await until(async () => (await drawnIn('Review', 1).count()) === 1, HUNG_MS)))
  const toDoing = page.locator('.dialog', { hasText: `Move ${await lib.cardLabel(inv, 1)} to Active` })
  check('dragging into Active asks who works on it', await dragged('into Active', 1, 'Active', async () => (await toDoing.count()) === 1))
  await toDoing.getByRole('button', { name: 'Move to Active' }).click()
  check('and moves it when confirmed', !!(await until(async () => (await card(1))?.column === 'doing', HUNG_MS)), (await card(1))?.column)
  await inv('tasks:update', 1, { column: 'todo' })

  // The card dialog saves only what the user changed: an agent's move meanwhile stays.
  const c3 = (await api('POST', '/v1/tasks', { title: 'Old title', project: 'beta' })).body.number
  await until(async () => (await tile(c3).count()) === 1, 5000)
  await tile(c3).click()
  const edit = lib.cardDialog(page, await lib.cardLabel(inv, c3))
  await edit.waitFor({ timeout: 5000 })
  await api('PATCH', `/v1/tasks/${c3}`, { column: 'review' })
  await lib.sleep(500)
  await edit.locator('.task-title-input').fill('New title')
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  const c3b = await until(async () => {
    const c = await card(c3)
    return c?.title === 'New title' && c
  }, 5000)
  check("saving the dialog keeps an agent's change made while it was open", c3b && c3b.column === 'review', JSON.stringify(c3b && { column: c3b.column }))
  await inv('tasks:delete', c3)

  // Start #1 on a new agent: it gets the card as its prompt, and the card goes to Doing.
  await tile(1).click()
  const open = lib.cardDialog(page, await lib.cardLabel(inv, 1))
  await open.waitFor({ timeout: 5000 })
  await page.screenshot({ path: path.join(lib.WORK, 'board-card.png') })
  await open.getByRole('button', { name: 'Start…' }).click()
  await page.screenshot({ path: path.join(lib.WORK, 'board-start.png') })
  const startDialog = page.locator('.dialog', { hasText: `Start ${await lib.cardLabel(inv, 1)}` })
  await startDialog.locator('label.choice', { hasText: 'A new agent' }).first().click()
  // A new agent's connection, not a provider (HI-2121, decision A): the connection picker, no provider choice.
  const picker = await until(async () => (await startDialog.locator('#start-agent-connection').count()) === 1, 5000)
  check("Start's new agent chooses a connection, not a provider", picker && (await startDialog.getByText('Provider', { exact: true }).count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'board-start-new-agent.png') })
  await startDialog.getByRole('button', { name: 'Start' }).click()
  const project = async () => (await inv('workspace:get')).projects.find((p) => p.name === 'alpha')
  const agent = await until(async () => (await project())?.agents[0], HUNG_MS)
  check('Start adds an agent to the project', !!agent)
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  const ran = !!(await until(async () => (await live())?.status === 'finished', 30000))
  check('and runs the card', ran, `${(await live())?.status}: ${String(await inv('pty:buffer', lib.ptyKey(alpha, agent.id))).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').slice(-600)}`)
  const c1b = await card(1)
  check('the card is in Doing, given to the agent', c1b.column === 'doing' && c1b.agent === agent.id, JSON.stringify({ column: c1b.column, agent: c1b.agent }))
  const tr = fs.readdirSync(path.join(claudeHome, 'projects'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
  const text = tr.map((f) => fs.readFileSync(path.join(claudeHome, 'projects', String(f)), 'utf8')).join('\n')
  check('the agent got the card as its prompt, named by key alone (#1219, HI-1661)', /Work on task [A-Z]{2,4}-1 from the Combwork task board: Add a greeting/.test(text) && text.includes('hello()'), text.slice(0, 200))
  check('its tile shows the agent finished', !!(await until(async () => ((await tile(1).getAttribute('class')) ?? '').includes('finished') && /Finished/.test(await tile(1).innerText()), 8000)), await tile(1).innerText())
  await page.screenshot({ path: path.join(lib.WORK, 'board.png') })

  // Its agent stops: nobody is working on the Doing card, which shows as stalled.
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 10000)
  check('a Doing card whose agent stopped shows as stalled', !!(await until(async () => ((await tile(1).getAttribute('class')) ?? '').includes('stalled') && /Stalled: .* isn't running/.test(await tile(1).innerText()), 8000)), await tile(1).innerText())
  check('the sidebar lists stalled cards', !!(await until(async () => (await page.locator('.section-header', { hasText: 'Stalled' }).count()) === 1, 5000)))
  const viaApi = await api('GET', '/v1/tasks/1')
  check('the Agent API says why it is stalled', /isn't running/.test(viaApi.body?.stalled ?? ''), JSON.stringify(viaApi.body?.stalled))
  await page.screenshot({ path: path.join(lib.WORK, 'board-stalled.png') })

  // More work on a Done card: right-click → Start… on its stopped agent; Doing again, and the prompt says it's back.
  await inv('tasks:update', 1, { column: 'done' })
  await until(async () => (await column('Done').locator('.task-card[data-task="1"]').count()) === 1, 5000)
  await tile(1).click({ button: 'right' })
  const startItem = page.locator('.menu .menu-item', { hasText: 'Start…' })
  check('Start… is on for a Done card', (await startItem.count()) === 1 && !(await startItem.evaluate((e) => e.classList.contains('disabled') || e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true')))
  await startItem.click()
  const again = page.locator('.dialog', { hasText: `Start ${await lib.cardLabel(inv, 1)}` })
  await again.waitFor({ timeout: 5000 })
  await again.getByRole('button', { name: 'Start' }).click()
  const reran = !!(await until(async () => (await live())?.status === 'finished', 30000))
  const c1c = await card(1)
  check('a Done card started again is in Doing with its agent', reran && c1c.column === 'doing' && c1c.agent === agent.id, JSON.stringify({ reran, column: c1c.column, agent: c1c.agent }))
  const tr2 = fs.readdirSync(path.join(claudeHome, 'projects'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
  check('its prompt says it is back for more work', tr2.some((f) => fs.readFileSync(path.join(claudeHome, 'projects', String(f)), 'utf8').includes('It was in Done and is back in Doing for more work.')))
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 10000)

  // Column colours (Settings → Board): each column's heading and a tint on its cards, in both themes; a picked colour;
  // turned off. Two workspace cards fill Done and show a blocked card.
  const extra = [await inv('tasks:create', { title: 'Shipped thing', project: '' }), await inv('tasks:create', { title: 'Waiting on a decision', project: '' })]
  await inv('tasks:update', extra[0].number, { column: 'done' })
  await inv('tasks:update', extra[1].number, { blocked: 'Needs a decision' })
  const bg = (n) => tile(n).evaluate((e) => getComputedStyle(e).backgroundColor)
  /** Whether the window shows that theme (settings reach it as an event, after settings:update returns). */
  const themeIs = async (theme) => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme
  const edge = (n) => tile(n).evaluate((e) => getComputedStyle(e).borderLeftColor)
  check('cards are tinted by their column', !!(await until(async () => (await tile(extra[0].number).count()) === 1 && new Set([await bg(1), await bg(2), await bg(extra[0].number), await bg(extra[1].number)]).size === 4, 5000)), JSON.stringify([await bg(1), await bg(2)]))
  const heading = (name) => column(name).locator('.board-column-label').evaluate((e) => getComputedStyle(e).color)
  check('column headings have their own colours', new Set([await heading('Todo'), await heading('Active'), await heading('Review'), await heading('Done')]).size === 4)
  const doingBg = await bg(1)
  // Each card's #number against its own background (WCAG contrast; tints come back as color(srgb …), 0–1 or 0–255).
  const numberContrast = () =>
    page.locator('.board-view .task-card').evaluateAll((els) => {
      const parse = (s) => {
        const v = (s.match(/[\d.]+/g) ?? []).map(Number).slice(0, 3)
        return s.startsWith('color(') ? v.map((x) => x * 255) : v
      }
      const lum = (c) => {
        const [r, g, b] = c.map((x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      return els.map((el) => {
        const a = lum(parse(getComputedStyle(el.querySelector('.task-number')).color))
        const b = lum(parse(getComputedStyle(el).backgroundColor))
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
      })
    })
  const readable = async (what) => {
    const r = await numberContrast()
    check(`card numbers are readable: ${what}`, r.length >= 4 && r.every((x) => x >= 4.5), JSON.stringify(r))
  }
  await readable('dark, coloured columns')
  await tile(2).hover()
  await until(() => tile(2).evaluate((el) => el.matches(':hover')).catch(() => false), 5000)
  await readable('dark, coloured, hovered')
  check('the state edges stay over the tint', (await edge(1)) !== (await edge(extra[1].number)) && (await edge(2)) === 'rgba(0, 0, 0, 0)', JSON.stringify([await edge(1), await edge(extra[1].number), await edge(2)]))
  await page.screenshot({ path: path.join(lib.WORK, 'board-colours-dark.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  check('the tint follows the theme', !!(await until(async () => (await themeIs('light')) && (await bg(1)) !== doingBg, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'board-colours-light.png') })
  await readable('light, coloured columns')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await inv('settings:update', { board: { colors: { doing: '#ff0000' } } })
  // Mixed colours come back as color(srgb r g b): red now leads.
  const rgb = async (n) => ((await bg(n)).match(/[\d.]+/g) ?? []).map(Number).slice(-3)
  check('a picked colour is used', !!(await until(async () => {
    const [r, g, b] = await rgb(1)
    return r > g * 1.3 && r > b * 1.3
  }, 5000)), await bg(1))
  await inv('settings:update', { board: { columnColors: false } })
  check('Colour columns off: no tint', !!(await until(async () => !((await page.locator('.board').first().getAttribute('class')) ?? '').includes('colored') && (await bg(1)) === (await bg(2)), 5000)))
  await readable('dark, plain')
  await inv('settings:update', { appearance: { theme: 'light' } })
  await until(() => themeIs('light'), 5000)
  await readable('light, plain')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await inv('settings:update', { board: { columnColors: true, colors: { doing: '#3b82f6' } } })
  for (const c of extra) await inv('tasks:delete', c.number)

  // Long text (#372): a blocked reason with a 120-character hash and a long Windows path wraps inside the card, at most
  // three lines, all of it on hover and in the card's dialog (a field that wraps, where Enter adds no line break); a long
  // label ends in "…"; nothing on the card reaches past its edge, in both themes.
  const HASH = 'CC70E25605DD72A71E72C689318'.repeat(5).slice(0, 120)
  const reason = `DOCS ACCEPTED at ${HASH}, record in C:\\Users\\Someone\\AppData\\Local\\combwork-test\\e2e\\logs\\run-20261007-123453\\progress\\progress-shots\\light-recent-all.png`
  const long = await inv('tasks:create', { title: 'Docs accepted', project: '', labels: [`label-${HASH.slice(0, 60)}`, 'ui'] })
  await inv('tasks:update', long.number, { blocked: reason })
  await until(async () => (await tile(long.number).locator('.task-blocked').count()) === 1, 5000)
  const shape = () =>
    tile(long.number).evaluate((tileEl) => {
      const box = tileEl.getBoundingClientRect()
      const note = tileEl.querySelector('.task-blocked .task-note-text')
      const label = tileEl.querySelector('.task-label')
      return {
        cardFits: tileEl.scrollWidth <= tileEl.clientWidth,
        past: [...tileEl.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > box.right + 1).map((e) => e.className),
        noteFits: note.scrollWidth <= note.clientWidth,
        lines: Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight)),
        clamped: note.scrollHeight > note.clientHeight + 1,
        labelCut: getComputedStyle(label).textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth && label.getBoundingClientRect().right <= box.right + 1
      }
    })
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(() => themeIs(theme), 5000)
    await tile(long.number).scrollIntoViewIfNeeded()
    const g = await shape()
    check(`${theme}: a long blocked reason wraps inside the card, clamped to 3 lines; nothing reaches past the card`, g.cardFits && g.past.length === 0 && g.noteFits && g.lines === 3 && g.clamped, JSON.stringify(g))
    check(`${theme}: a long label ends in "…" inside the card`, g.labelCut, JSON.stringify(g))
    await page.screenshot({ path: path.join(lib.WORK, `board-long-${theme}.png`) })
  }
  await lib.hoverTip(page, tile(long.number).locator('.task-blocked'), (t) => t.startsWith('Blocked:'))
  const longTip = await page.locator('.tip:visible').last().evaluate((el) => ({ text: el.textContent, fits: el.scrollWidth <= el.clientWidth }))
  check('hovering it shows the whole reason, inside the tooltip', longTip.text === `Blocked: ${reason}` && longTip.fits, JSON.stringify(longTip))
  await page.mouse.move(5, 5)
  await tile(long.number).locator('.task-title').click()
  const blockedField = page.locator('.dialog textarea[aria-label="Blocked"]')
  await blockedField.waitFor()
  const field = await blockedField.evaluate((el) => ({ value: el.value, whole: el.scrollHeight <= el.clientHeight + 1, fits: el.scrollWidth <= el.clientWidth }))
  check("the card's dialog shows the whole reason, wrapped", field.value === reason && field.whole && field.fits, JSON.stringify(field))
  await blockedField.focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  check('Enter in it adds no line break', (await blockedField.inputValue()) === reason)
  await page.screenshot({ path: path.join(lib.WORK, 'board-long-dialog.png') })
  check('Escape closes the card dialog', await escapeCloses(page.locator('.dialog')))
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // A reason near the 1000-character limit, in a small window at 125% (review round 1): its tooltip widens to the window
  // so all of it fits, its last line on screen, in both themes.
  const nearLimit = `DOCS ACCEPTED at ${'W'.repeat(120)} C:\\` + `${'W'.repeat(100)}\\`.repeat(8)
  await inv('tasks:update', long.number, { blocked: nearLimit })
  await lib.fitWindow(app, page, { width: 1000, height: 700 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(400)
    await page.mouse.move(5, 5)
    await tile(long.number).locator('.task-blocked').scrollIntoViewIfNeeded()
    await tile(long.number).locator('.task-blocked').hover()
    await lib.sleep(900)
    const t = await page.locator('.tip').last().evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: window.innerWidth, vh: window.innerHeight, whole: el.scrollHeight <= el.clientHeight + 1, text: el.textContent }
    })
    check(`${theme}, 1000×700 at 125%: a ${nearLimit.length}-character reason's tooltip fits the window, all of it shown`, t.text === `Blocked: ${nearLimit}` && t.whole && t.top >= 0 && t.left >= 0 && t.bottom <= t.vh && t.right <= t.vw, JSON.stringify({ ...t, text: t.text.length }))
    await page.screenshot({ path: path.join(lib.WORK, `board-long-tip-${theme}.png`) })
  }
  await page.mouse.move(5, 5)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // In Doing with nobody on it, it is stalled: the sidebar's Stalled row ends its long title in "…" inside the sidebar.
  await inv('tasks:update', long.number, { title: `Stalled ${HASH}`, column: 'doing' })
  const sideRow = page.locator('.sidebar .row', { hasText: `#${long.number}` })
  await until(async () => (await sideRow.count()) === 1, 5000)
  const side = await sideRow.evaluate((el) => ({ right: el.getBoundingClientRect().right, edge: el.closest('.sidebar').getBoundingClientRect().right, cut: el.querySelector('.label').scrollWidth > el.querySelector('.label').clientWidth }))
  check("the sidebar's Stalled row ends a long title in \"…\" inside the sidebar", side.right <= side.edge + 1 && side.cut, JSON.stringify(side))
  await inv('tasks:delete', long.number)

  // The project's Tasks tab shows its cards.
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.locator('.sidebar .row', { hasText: 'alpha' }).first().click()
  await page.locator('.tab', { hasText: 'Tasks' }).click()
  check("the project's Tasks tab shows its cards", !!(await until(async () => (await page.locator('.board-view.in-tab .task-card').count()) === 2, 5000)))

  // Removing the agent asks about its open card; Move them back puts it in Todo with nobody.
  // Project Settings opens on General; the agents are listed under Agents (HI-1765).
  await lib.openProjectSettings(page)
  await page.locator('.tab-body .settings-nav .row').filter({ has: page.locator('.label', { hasText: /^Agents$/ }) }).click()
  await page.getByRole('button', { name: 'Remove agent…' }).first().click()
  await page.locator('.dialog .btn', { hasText: 'Remove' }).click()
  const ask = page.locator('.dialog', { hasText: 'open card' })
  check('Remove Agent asks about its open cards', !!(await until(async () => (await ask.count()) === 1 && (await ask.innerText()).includes(`${await lib.cardLabel(inv, 1)} Add a greeting`), 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'board-remove-agent.png') })
  await ask.getByRole('button', { name: /Move (it|them) back/ }).click()
  const back = await until(async () => {
    const c = await card(1)
    return c?.agent === null && c
  }, 8000)
  check('Move them back puts the card in Todo with nobody', back && back.column === 'todo', JSON.stringify(back && { column: back.column, agent: back.agent }))
  check('and the agent is gone', !!(await until(async () => (await project())?.agents.length === 0, 5000)))
  await page.locator('.tab', { hasText: 'Tasks' }).click()

  // The user moves it to Done, and archives it.
  await inv('tasks:update', 1, { column: 'done' })
  await inv('tasks:archive', 1, true)
  check('archived cards leave the board', !!(await until(async () => (await page.locator('.board-view.in-tab .task-card').count()) === 1, 5000)))
  await page.locator('.board-view.in-tab label', { hasText: 'Archived' }).click()
  check('and are listed under Archived', !!(await until(async () => (await page.locator('.archived-cards tbody tr.clickable').count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'board-tab.png') })

  // Project → Remove Project…: Hide delta.
  const removeVia = async (name, choice) => {
    await page.locator('.sidebar .row', { hasText: name }).first().click({ button: 'right' })
    await page.locator('.menu .menu-item', { hasText: 'Remove Project…' }).click()
    const d = page.locator('.dialog', { hasText: `Remove ${name}` })
    await d.waitFor({ timeout: 5000 })
    await until(async () => (await d.locator('label.choice').count()) === 3, 5000)
    await d.locator('label.choice').filter({ has: page.getByText(choice, { exact: true }) }).click()
    return d
  }
  await inv('tasks:create', { title: 'Delta work', project: 'delta' })
  // An agent with a long name on its own worktree (#1316): Remove Project's table shows its name and branch whole.
  const longName = 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF'
  await inv('agents:testLegacy', path.join(ws, 'delta'), { location: 'new-worktree', name: longName })
  const longBranch = JSON.parse(fs.readFileSync(path.join(ws, 'delta', '.combwork', 'project.json'), 'utf8')).agents.find((a) => a.name === longName)?.worktree?.branch
  let d = await removeVia('delta', 'Hide')
  // What it touches is a table (#1316): a thing and what happens to it, for the choice made; the folder by its name, its
  // full path behind it (on hover, and copied whole). Each choice shown in both themes, then back to Hide.
  const touched = () => d.locator('.removal-list tbody tr').evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim())))
  const folderRow = async () => (await touched()).find((cells) => cells[0].startsWith('Folder')) ?? []
  check('What it touches is a table, What · What happens, the folder by name', (await d.locator('.removal-list thead th').allInnerTexts()).slice(0, 2).join('|') === 'WHAT|WHAT HAPPENS' && (await d.locator('.removal-list .short-path[data-path]').getAttribute('data-path')).toLowerCase() === path.join(ws, 'delta').toLowerCase() && (await d.locator('.removal-list .short-path-text').innerText()) === 'delta', JSON.stringify(await touched()))
  const themed = async (theme) => {
    await inv('settings:update', { appearance: { theme } })
    if (!(await until(() => themeIs(theme), HUNG_MS))) throw new Error(`the window didn't show the ${theme} theme`)
  }
  // Every cell's content fits it: a long name or branch wraps inside itself, never cut (only the folder's short name is).
  const cellsFit = () => d.locator('.removal-list tbody td').evaluateAll((tds) => tds.length > 0 && tds.every((td) => td.scrollWidth <= td.clientWidth + 1))
  for (const [choice, happens] of [['Hide', 'stays, hidden from Combwork'], ['Remove from Combwork', 'stays where it is'], ['Delete', 'to the Recycle Bin']]) {
    await d.locator('label.choice').filter({ has: page.getByText(choice, { exact: true }) }).click()
    check(`…${choice}: the folder ${happens}`, !!(await until(async () => (await folderRow())[1] === happens, HUNG_MS)), JSON.stringify(await touched()))
    check(`…${choice}: the long agent's worktree whole, its name and branch, every cell fitting`, !!longBranch && (await touched()).some((cells) => cells[0] === `${longName} (${longBranch})`) && !!(await until(cellsFit, HUNG_MS)), JSON.stringify({ longBranch, rows: await touched() }))
    for (const theme of ['dark', 'light']) {
      await themed(theme)
      await page.screenshot({ path: path.join(lib.WORK, `board-remove-${choice.toLowerCase().replace(/ /g, '-')}-${theme}.png`) })
    }
    await themed('dark')
  }
  await d.locator('label.choice').filter({ has: page.getByText('Hide', { exact: true }) }).click()
  await d.locator('.dialog-footer .btn', { hasText: 'Hide' }).click()
  const names = async () => (await inv('workspace:get')).projects.map((p) => p.name)
  check('Hide takes the project out of Combwork', !!(await until(async () => !(await names()).includes('delta'), 8000)))
  check('its folder stays', fs.existsSync(path.join(ws, 'delta')))
  const deltaCards = (await cards()).filter((c) => c.project === 'delta')
  // Evidence for #548: missing (a read that failed) or there but not archived (Hide missed it).
  check('and its cards are archived', deltaCards[0]?.archivedFor === 'project-hidden', JSON.stringify(deltaCards.map((c) => ({ n: c.number, archived: c.archived, archivedFor: c.archivedFor }))))
  await page.getByRole('button', { name: 'Settings' }).click()
  // Settings → Board: the switch and a picker per column (Doing was changed and put back, so no reset shows).
  await page.locator('.settings-nav .row').filter({ has: page.getByText('Board', { exact: true }) }).click()
  check('Settings → Board has a colour picker per column', !!(await until(async () => (await page.locator('.column-color input[type="color"]').count()) === 6, 5000)))
  check('only changed colours offer a reset', (await page.locator('.column-color .icon-btn').count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'board-settings-colours.png') })
  await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
  const row = page.locator('.hidden-projects tr', { hasText: 'delta' })
  check('Settings → Workspace lists it', !!(await until(async () => (await row.count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'board-settings.png') })
  await row.getByRole('button', { name: 'Restore' }).click()
  check('Restore brings it back', !!(await until(async () => (await names()).includes('delta'), 8000)))
  check('with its cards', !(await cards()).find((c) => c.project === 'delta')?.archived)

  // Delete gamma: the name has to be typed.
  await page.getByRole('button', { name: 'Projects' }).click()
  d = await removeVia('gamma', 'Delete')
  const del = d.locator('.dialog-footer .btn', { hasText: 'Delete' })
  check('Delete waits for the name to be typed', await del.isDisabled())
  await page.screenshot({ path: path.join(lib.WORK, 'board-remove.png') })
  await d.locator('input.input').fill('gamma')
  await del.click()
  check('Delete moves the folder to the Recycle Bin', !!(await until(async () => !fs.existsSync(path.join(ws, 'gamma')), 10000)))
  // A test copy's Recycle Bin is the suite's own trash folder (#414): the folder arrived there, whole. Combwork notes the
  // move in trash.jsonl just after it, so wait for the note (#441).
  const arrived = () => lib.trashed(path.join(ws, 'gamma')).find((e) => e.from.toLowerCase() === path.join(ws, 'gamma').toLowerCase() && fs.existsSync(e.to))
  check("…which in a test copy is the suite's own trash folder, not the user's Recycle Bin", !!(await until(async () => arrived(), 5000)), JSON.stringify(lib.trashed()))
  check('and Combwork forgets it', !!(await until(async () => !(await names()).includes('gamma'), 8000)))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
