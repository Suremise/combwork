// Lanes from the window (#1280, SPEC §16.11.3, S21's window part with the Assistant off), on fake Claude Code agents:
// the Todo column's menu opens Start Lane with its cards in order (moved up and down there), Start records the lane and
// starts both agents in fresh conversations with the generated brief (B1, running and idle, gets a new conversation; R1,
// stopped, is started), the lane shows in the Progress panel, its menu has End Lane and Abandon Lane…, Abandon asks
// first, End ends it; the Lanes tab's Start Lane… starts another, which Abandon ends. B1 is given its first card and its
// brief in one task, one turn, with no "end your turn, it's coming" round (HI-2558). Screenshots of the dialog and the
// lane's menu in both themes. HI-3148: Start Lane… on a released branch (1.0.0, tagged v1.0.0 and in main) says so,
// its Start Anyway needs a reason, and the lane's card is then started on 1.0.0 under the lane's grant. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47843))
const userData = path.join(lib.WORK, 'lanestart-profile')
const ws = path.join(lib.WORK, 'lanestart-ws')
const claudeHome = path.join(lib.WORK, 'lanestart-claude-home')
const shots = path.join(lib.WORK, 'lanestart-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  // Every read of the agents' input recorded, for typeLine.
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  // HI-3148: 1.0.0 released: a branch whose annotated tag v1.0.0 is in its history, its head in main's.
  lib.git(alpha, ['branch', '1.0.0'])
  lib.git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v1.0.0', '-m', 'release 1.0.0', '1.0.0'])
  // The lane's slot too (#1438): its builder works in slot-a, a new branch per card.
  const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase(), slotA.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    // A reviewer agent reviews each card: the brief says so.
    const options = { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', preChecks: ['typecheck'], commands: { typecheck: 'npm run typecheck' } }
    await inv('workflow:setOptions', alpha, { preset: null, options })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    // B1 running and idle (it gets a new conversation); R1 stopped (it is started with its brief).
    await inv('session:start', alpha, { agentId: b1.id })
    check('B1 runs, idle', !!(await until(async () => (await live(b1.id))?.status === 'ready', HUNG_MS)))
    const firstSession = (await live(b1.id))?.sessionId
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (route) => (await fetch(`http://127.0.0.1:${PORT}${route}`, { headers: { Authorization: `Bearer ${workspaceToken}` } })).json()
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    for (const title of ['Lane data', 'Lane hover']) await inv('tasks:create', { title, project: 'alpha' })
    const c = await inv('tasks:create', { title: 'Docs', project: 'alpha' })
    const shoot = async (name, target = page) => {
      // No tooltip of the last click in the picture.
      await page.mouse.move(2, 2)
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await target.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
    await until(async () => (await column('Todo').locator('.task-card').count()) === 3, HUNG_MS)
    const item = (label) => page.locator('.menu[role="menu"] .menu-item', { hasText: label })
    const dialog = page.locator('.dialog', { hasText: 'Start Lane' })
    const openFromTodo = async () => {
      await column('Todo').locator('.board-column-header').click({ button: 'right' })
      await until(async () => (await item('Start Lane with These Cards…').count()) === 1, HUNG_MS)
      await item('Start Lane with These Cards…').click()
      return until(async () => (await dialog.count()) === 1, HUNG_MS)
    }
    const brief = async (agent) => {
      const v = await api(`/v1/projects/alpha/agents/${agent}/deliveries?limit=5`)
      return (v.items ?? v.deliveries ?? []).map((d) => d.body ?? d.text ?? '').join('\n')
    }

    // --- HR6's round 1: B1 busy, Wait and Start, then Cancel: when B1 is idle again, nothing starts.
    // Typed again when a wake of Combwork's disturbed it (typeLine): taken once B1 works.
    const working = async () => (await live(b1.id))?.status === 'working'
    await lib.typeLine(inv, lib.ptyKey(alpha, b1.id), claudeHome, 'B1', 'holduntil lanestart-cancel-go', { ready: async () => ['ready', 'finished'].includes((await live(b1.id))?.status), taken: working, hungMs: HUNG_MS })
    check('B1 is working', !!(await until(working, HUNG_MS)))
    await openFromTodo()
    const waitButton = dialog.getByRole('button', { name: 'Wait and Start' })
    check('the dialog says B1 is busy and offers to wait', !!(await until(async () => (await waitButton.count()) === 1 && /B1 is busy now/.test(await dialog.innerText()), HUNG_MS)), await dialog.innerText().catch(() => ''))
    await waitButton.click()
    check('…Wait and Start waits for it', !!(await until(async () => /Waiting for these agents to be idle: B1/.test(await dialog.innerText()), HUNG_MS)))
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    check('Cancel closes the dialog', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)))
    fs.writeFileSync(path.join(claudeHome, 'lanestart-cancel-go'), '')
    check('B1 is idle again', !!(await until(async () => ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)))
    // Its next status changes (the turn's end settling) would have started it: the lane list, B1's session and its
    // deliveries are read after them, a few times, and stay as they were.
    let still = true
    for (let i = 0; i < 5 && still; i++) {
      await until(async () => ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)
      still = (await inv('lanes:list')).length === 0 && (await live(b1.id))?.sessionId === firstSession && !/builder of a lane/.test(await brief('B1'))
    }
    check('…and nothing started: no lane, the same conversation, no brief', still, JSON.stringify({ lanes: await inv('lanes:list'), session: (await live(b1.id))?.sessionId, firstSession }))

    // --- The Todo column's menu: Start Lane with These Cards…, its cards in the column's order.
    await openFromTodo()
    const order = () => dialog.locator('.lane-start-cards > li[data-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card'))))
    check('Start Lane opens with the Todo cards, in the column\'s order', !!(await until(async () => (await dialog.count()) === 1 && (await order()).length === 3, HUNG_MS)), JSON.stringify(await order()))
    const todoOrder = await order()
    check('…B1 as builder, R1 as reviewer', (await dialog.locator('#lane-start-builder').inputValue()) === b1.id && (await dialog.locator('#lane-start-reviewer').inputValue()) === r1.id)
    // C out, B before A.
    await dialog.locator(`.lane-start-cards > li[data-card="${c.number}"] button[aria-label^="Take"]`).click()
    const second = (await order())[1]
    await dialog.locator(`.lane-start-cards > li[data-card="${second}"] button[aria-label^="Move"][aria-label$="up"]`).click()
    const chosen = await order()
    check('a card taken out, another moved up', chosen.length === 2 && chosen[0] === second && !chosen.includes(c.number), JSON.stringify({ todoOrder, chosen }))
    await dialog.locator('#lane-start-name').fill('from the window')
    await dialog.locator('#lane-start-note').fill('Keep the API stable.')
    await shoot('dialog', dialog)

    // --- Start: the lane recorded; both agents in a fresh conversation with their brief.
    const startedAt = new Date().toISOString()
    await dialog.getByRole('button', { name: 'Start Lane' }).click()
    check('the dialog closes', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)), await dialog.locator('.dialog-error, .error').innerText().catch(() => ''))
    const lanes = async () => (await inv('lanes:list')).filter((l) => l.state === 'active' || l.state === 'paused')
    const started = await until(async () => (await lanes()).find((l) => l.builder.id === b1.id), HUNG_MS)
    check('the lane is recorded: B1 / R1, the cards in that order, its name', !!started && started.reviewer?.id === r1.id && JSON.stringify(started.cards.map((x) => x.number)) === JSON.stringify(chosen) && started.name === 'from the window', JSON.stringify(started))
    check('B1 is in a new conversation', !!(await until(async () => {
      const s = await live(b1.id)
      return !!s?.sessionId && s.sessionId !== firstSession
    }, HUNG_MS)), JSON.stringify(await live(b1.id)))
    check('R1 is started', !!(await until(async () => !!(await live(r1.id)), HUNG_MS)))
    // B1's prompts in its new conversation (HI-2558: one doorbell), and what it read for them, whole, as the fake logs it
    // (a delivery's listing shortens its body): its brief came with its first card.
    const prompts = async () => {
      const s = await live(b1.id)
      const items = s?.sessionId ? ((await inv('transcript:read', alpha, s.sessionId).catch(() => null))?.items ?? []) : []
      return items.filter((x) => x.kind === 'user')
    }
    const wakesFile = path.join(claudeHome, 'fake-wakes.jsonl')
    const b1Read = () => (fs.existsSync(wakesFile) ? fs.readFileSync(wakesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === 'B1' && (w.at ?? '') >= startedAt)
    const b1Brief = async () => b1Read().map((w) => w.text ?? '').join('\n')
    check("B1's brief: the builder of the lane, card-loop as the builder, with R1", !!(await until(async () => /You are the builder of a lane in alpha that the user started: use the card-loop skill as the builder, with R1 as the reviewer/.test(await b1Brief()), HUNG_MS)), (await b1Brief()).slice(0, 400))
    check("…B1 works in the lane's slot, a new branch per card (#1438)", /B1 works in slot-a, a new branch per card/.test(await b1Brief()), (await b1Brief()).slice(0, 600))
    check("R1's brief: the reviewer of B1's lane", !!(await until(async () => /You are the reviewer of B1's lane in alpha/.test(await brief('R1')), HUNG_MS)), (await brief('R1')).slice(0, 400))

    // --- HI-2558: B1's brief and its first card in one task, with no "end your turn, it's coming" round. Since the start
    // B1 was given one task, its first card with the brief in it, placed in the lane's slot; once B1 is idle there
    // nothing more is given (before, the brief came first and the card a turn later), and its new conversation has had
    // one prompt, one turn.
    const given = async () => {
      const v = await api(`/v1/projects/alpha/agents/B1/deliveries?limit=20`)
      return (v.items ?? v.deliveries ?? []).filter((d) => (d.created ?? '') >= startedAt && d.kind === 'task')
    }
    const placed = async () => ((await inv('tasks:facts', chosen[0])) ?? []).some((f) => f.kind === 'BuilderPlaced')
    check(`B1's first card ${chosen[0]} is Active on B1 and placed in its slot`, !!(await until(async () => (await card(chosen[0]))?.column === 'doing' && (await placed()), HUNG_MS)), JSON.stringify({ card: await card(chosen[0]), facts: ((await inv('tasks:facts', chosen[0])) ?? []).map((f) => f.kind) }))
    const idleInSlot = async () => {
      const s = await live(b1.id)
      return ['ready', 'finished'].includes(s?.status) && /slot-a$/i.test(s?.cwd ?? '')
    }
    check('…B1 idle in slot-a after its turn', !!(await until(idleInSlot, HUNG_MS)), JSON.stringify(await live(b1.id)))
    // Looked at a few times as B1's status settles (another task would come now: the step-by-step start's card).
    let tasks = []
    for (let i = 0; i < 5; i++) {
      await until(idleInSlot, HUNG_MS)
      tasks = await given()
      if (tasks.length !== 1) break
    }
    // A delivery's listing shortens its body (its text): its start is enough to tell the card's task with the brief.
    const head = (d) => d.text ?? d.body ?? ''
    check('…one task given to B1 since the start: its first card, the brief in it', tasks.length === 1 && tasks[0].card === chosen[0] && /it is your lane's first card, and your lane's brief follows/.test(head(tasks[0])), JSON.stringify(tasks.map((d) => ({ card: d.card, text: head(d).slice(0, 300) }))))
    const one = await prompts()
    check("…B1's new conversation has had one prompt (one turn), that task's", one.length === 1 && /New in your inbox: 1 task/.test(one[0].text ?? ''), JSON.stringify(one.map((x) => (x.text ?? '').slice(0, 160))))
    const read = b1Read()
    check('…what B1 read for it: the card, then its brief whole, no "End your turn now"', read.length === 1 && (read[0].text ?? '').startsWith('Work on task ') && /You are the builder of a lane in alpha/.test(read[0].text ?? '') && /The user's note: Keep the API stable\./.test(read[0].text ?? '') && !/End your turn now/.test(read[0].text ?? ''), JSON.stringify(read.map((w) => (w.text ?? '').slice(0, 160))))

    // --- The lane in the Progress panel; its menu: End Lane and Abandon Lane….
    await page.locator('.progress-rail').click().catch(() => undefined)
    const panel = page.locator('.progress-panel')
    await until(async () => (await panel.count()) === 1, HUNG_MS)
    const row = panel.locator(`.progress-lane[data-lane="${started.id}"]`)
    check('the lane shows in the Progress panel', !!(await until(async () => (await row.count()) === 1, HUNG_MS)))
    await row.locator('.progress-lane-top').click({ button: 'right' })
    check('its menu has End Lane, Abandon Lane… and Start Lane…', !!(await until(async () => (await item('End Lane').count()) === 1 && (await item('Abandon Lane…').count()) === 1 && (await item('Start Lane…').count()) === 1, HUNG_MS)))
    await shoot('lane-menu')
    await item('Abandon Lane…').click()
    const ask = page.locator('.dialog', { hasText: 'Abandon' })
    check('Abandon asks first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)) && /The lane stops here, unmerged/.test(await ask.innerText()), await ask.innerText().catch(() => ''))
    await ask.getByRole('button', { name: 'Cancel' }).click()
    check('…and Cancel leaves it running', !!(await until(async () => (await ask.count()) === 0, HUNG_MS)) && (await lanes()).some((l) => l.id === started.id))
    await row.locator('.progress-lane-top').click({ button: 'right' })
    await until(async () => (await item('End Lane').count()) === 1, HUNG_MS)
    await item('End Lane').click()
    check('End Lane ends it', !!(await until(async () => (await inv('lanes:list')).find((l) => l.id === started.id)?.state === 'ended', HUNG_MS)), JSON.stringify((await inv('lanes:list')).find((l) => l.id === started.id)))

    // --- The Lanes tab's Start Lane…: another lane (card C), which Abandon ends.
    await panel.locator('.progress-tab[data-tab="lanes"]').click()
    await until(async () => (await panel.locator('.progress-tab-lanes').count()) === 1, HUNG_MS)
    // B1's lane ended: its session in the lane's slot is stopped once its turn is over (#1438), freeing the slot.
    await until(async () => !(await live(b1.id)) || (await live(b1.id))?.status === 'ready' || (await live(b1.id))?.status === 'finished', HUNG_MS)
    await until(async () => (await live(r1.id))?.status === 'ready' || (await live(r1.id))?.status === 'finished', HUNG_MS)
    await panel.locator('.progress-lanes-start').first().click()
    check("the Lanes tab's Start Lane… opens the dialog", !!(await until(async () => (await dialog.count()) === 1, HUNG_MS)))
    await dialog.locator('.lane-start-add').selectOption(String(c.number))
    check('…a card added from Todo', JSON.stringify(await order()) === JSON.stringify([c.number]))
    await dialog.getByRole('button', { name: /^(Start Lane|Wait and Start)$/ }).click()
    const again = await until(async () => (await lanes()).find((l) => l.builder.id === b1.id && l.cards.some((x) => x.number === c.number)), HUNG_MS)
    check('…and starts a lane of it', !!again, JSON.stringify(await lanes()))
    const row2 = panel.locator(`.progress-tab-lanes .progress-lane[data-lane="${again?.id}"]`)
    await until(async () => (await row2.count()) === 1, HUNG_MS)
    await row2.locator('.progress-lane-top').click({ button: 'right' })
    await until(async () => (await item('Abandon Lane…').count()) === 1, HUNG_MS)
    await item('Abandon Lane…').click()
    await until(async () => (await ask.count()) === 1, HUNG_MS)
    await ask.getByRole('button', { name: 'Abandon Lane' }).click()
    check('Abandon Lane, confirmed, abandons it', !!(await until(async () => (await inv('lanes:list')).find((l) => l.id === again?.id)?.state === 'abandoned', HUNG_MS)))
    // B1 idle, Combwork may have started C on it before the abandon (HI-2029): an abandon moves no card either way.
    const cStarted = ((await inv('tasks:facts', c.number)) ?? []).some((f) => f.kind === 'Started' && f.actor === 'combwork')
    check('…its cards stay where they were', (await card(c.number))?.column === (cStarted ? 'doing' : 'todo'), JSON.stringify({ cStarted, c: await card(c.number) }))
    // Back in Todo for what follows, as it was before Combwork's start.
    if (cStarted) await inv('tasks:move', c.number, 'todo', { confirm: true, reason: 'the e2e puts it back' })

    // --- HI-3168: a lane of B1's while the first lane's card (in Doing) still holds slot-a (below) says which slot and
    // card it waits for, in its status and its row in the Progress panel's Lanes tab. Abandoned before the slot is freed.
    const heldKey = (await card(chosen[0]))?.key
    const waitOn = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c.number], note: '' })
    check('a lane of B1’s while its first lane’s card holds slot-a waits for a slot', !!waitOn?.waitingForSlot && (await card(chosen[0]))?.column === 'doing', JSON.stringify({ waitingForSlot: waitOn?.waitingForSlot, held: (await card(chosen[0]))?.column }))
    const heldStatus = await until(async () => {
      const s = (await lanes()).find((l) => l.id === waitOn?.lane?.id)?.status
      return s?.reason === 'slot' && s.held === 'card' && s.slot === 'slot-a' && s.heldFor === chosen[0] && s.agent === 'B1' ? s : null
    }, HUNG_MS)
    check('…its status names slot-a, B1 and the card holding it', !!heldStatus, JSON.stringify((await lanes()).find((l) => l.id === waitOn?.lane?.id)?.status))
    const heldWhy = panel.locator(`.progress-tab-lanes .progress-lane[data-lane="${waitOn?.lane?.id}"] .progress-lane-why`)
    const heldSaid = `waiting for a slot: B1 still builds in slot-a for ${heldKey}, which keeps it until that card is Done or put back`
    check(`…its row in the Progress panel says "${heldSaid}"`, !!(await until(async () => ((await heldWhy.textContent().catch(() => '')) ?? '') === heldSaid, HUNG_MS)), await heldWhy.textContent().catch(() => ''))
    await shoot('lane-slot-card', panel)
    if (waitOn?.lane?.id) await inv('lanes:end', waitOn.lane.id, true)
    check('…abandoned, its card never started', !!(await until(async () => (await inv('lanes:list')).find((l) => l.id === waitOn?.lane?.id)?.state === 'abandoned', HUNG_MS)) && (await card(c.number))?.column === 'todo', JSON.stringify(await card(c.number)))

    // --- B1's slot freed for the lanes that follow (HI-3162). The first lane ended with its card in Doing, and that card
    // keeps its lease on slot-a (HI-3118), so every later lane of B1's is refused a slot (one agent, one slot: "this
    // agent already builds in slot-a for" that card) and waits for one, paused, "waiting for a slot": none of their cards is
    // started until that card is Done or put back. Put back here, as the user would.
    if ((await card(chosen[0]))?.column === 'doing') await inv('tasks:move', chosen[0], 'todo', { confirm: true, reason: 'the e2e frees its slot' })
    check(`the first lane's card ${chosen[0]} is back in Todo, freeing slot-a`, !!(await until(async () => (await card(chosen[0]))?.column === 'todo', HUNG_MS)), JSON.stringify(await card(chosen[0])))

    // --- HI-3148: Start Lane… on 1.0.0, released. The dialog says so before Start, naming the tag and main to start on
    // instead; Start Anyway waits for a reason; given one, the lane starts on 1.0.0 and its card is started there by
    // Combwork under the lane's grant (nobody else could: a start onto 1.0.0 is refused).
    const factsOf = async (n) => (await inv('tasks:facts', n)) ?? []
    const b1Quiet = async () => !(await live(b1.id)) || ['ready', 'finished'].includes((await live(b1.id))?.status)
    await inv('workflow:setOptions', alpha, { preset: null, options: { ...options, otherTargets: ['1.0.0'] } })
    const h1 = (await inv('tasks:create', { title: 'Hotfix 1.0.1', project: 'alpha' })).number
    await until(b1Quiet, HUNG_MS)
    // Start Lane from Todo with only the hotfix card in its list.
    await openFromTodo()
    await until(async () => (await order()).length > 0, HUNG_MS)
    for (const x of await order()) if (x !== h1) await dialog.locator(`.lane-start-cards > li[data-card="${x}"] button[aria-label^="Take"]`).click()
    // The new card reaches the window's Todo after the dialog may have opened: added from the picker if missing.
    if (!(await order()).includes(h1)) await dialog.locator('.lane-start-add').selectOption(String(h1))
    check('Start Lane with only the hotfix card', !!(await until(async () => JSON.stringify(await order()) === JSON.stringify([h1]), HUNG_MS)), JSON.stringify(await order()))
    const pickTarget = dialog.locator('#lane-start-target')
    check('Start Lane offers Merges into 1.0.0', !!(await until(async () => (await pickTarget.count()) === 1 && (await pickTarget.locator('option[value="1.0.0"]').count()) === 1, HUNG_MS)), await dialog.innerText().catch(() => ''))
    await pickTarget.selectOption('1.0.0')
    const warn = dialog.locator('[data-lane-released="1.0.0"]')
    check('…picked, it says 1.0.0 is released, naming its tag and main to start on instead', !!(await until(async () => (await warn.count()) === 1 && /^1\.0\.0 is released \(v1\.0\.0, tagged .+, merged into main\)\. Did you mean main\?/.test(await warn.innerText()), HUNG_MS)), await dialog.innerText().catch(() => ''))
    const anyway = dialog.getByRole('button', { name: 'Start Anyway' })
    check('…its button is Start Anyway, off until a reason is given', (await anyway.count()) === 1 && (await anyway.isDisabled()), await dialog.innerText().catch(() => ''))
    await dialog.locator('[data-lane-released-reason]').fill('hotfix 1.0.1')
    check('…on with a reason', !(await anyway.isDisabled()))
    await shoot('released', dialog)
    await anyway.click()
    check('…Start Anyway closes the dialog', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)), await dialog.innerText().catch(() => ''))
    const hot = await until(async () => (await lanes()).find((l) => l.builder.id === b1.id && l.cards.some((x) => x.number === h1)) ?? null, HUNG_MS)
    check('…the lane is recorded on 1.0.0', hot?.target === '1.0.0', JSON.stringify(hot))
    const hotStart = await until(async () => (await factsOf(h1)).find((f) => f.kind === 'Started' && f.actor === 'combwork') ?? null, 2 * 30000 + HUNG_MS)
    check("…and its card is started on 1.0.0 by Combwork, under the lane's grant", hotStart?.data?.target === '1.0.0', JSON.stringify({ hotStart, facts: (await factsOf(h1)).map((f) => f.kind) }))
    // Back as it was for what follows: the lane abandoned, its card in Todo.
    if (hot) await inv('lanes:end', hot.id, true)
    if ((await card(h1))?.column === 'doing') await inv('tasks:move', h1, 'todo', { confirm: true, reason: 'the e2e puts it back' })

    // --- HI-1995: Apply now. A lane of two, its first card started (B1 placed in the lane's slot); Start Lane for B1 with
    // the other card offers Apply now, which puts the first back in Todo and applies the new order.
    // Then, that second card in Review, the dialog says why it can't apply now. Screenshots of both.
    const [d1, d2] = [await inv('tasks:create', { title: 'Lane now one', project: 'alpha' }), await inv('tasks:create', { title: 'Lane now two', project: 'alpha' })].map((x) => x.number)
    await until(async () => !(await live(b1.id)) || ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)
    const third = await until(async () => {
      const r = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [d1, d2], note: '' }).catch(() => null)
      return r?.lane ?? null
    }, HUNG_MS)
    check('a lane of two is started for B1', !!third, JSON.stringify(await lanes()))
    const quiet = async () => ['ready', 'finished'].includes((await live(b1.id))?.status) && (await api(`/v1/projects/alpha/agents/B1/deliveries?limit=20`)).deliveries?.every((x) => !['queued', 'uncertain'].includes(x.state))
    await until(quiet, HUNG_MS)
    // HI-2029: nobody starts it: Combwork gives the lane's first card to B1 once B1 is free (the lane started over it).
    const facts = async (n) => (await inv('tasks:facts', n)) ?? []
    check("…its first card started by Combwork on B1, with no one starting it (HI-2029)", !!(await until(async () => (await facts(d1)).some((f) => f.kind === 'Started' && f.actor === 'combwork') && (await facts(d1)).some((f) => f.kind === 'BuilderPlaced'), HUNG_MS)), JSON.stringify({ facts: (await facts(d1)).map((f) => f.kind), lane: (await lanes()).find((l) => l.id === third?.id)?.status ?? null }))
    await until(quiet, HUNG_MS)
    /** Start Lane from the Todo column with only card n left in its list (the other Todo cards taken out). */
    const openWithOnly = async (n) => {
      await openFromTodo()
      await until(async () => (await order()).length > 0, HUNG_MS)
      for (const x of await order()) if (x !== n) await dialog.locator(`.lane-start-cards > li[data-card="${x}"] button[aria-label^="Take"]`).click()
      return until(async () => JSON.stringify(await order()) === JSON.stringify([n]), HUNG_MS)
    }
    await openWithOnly(d2)
    const applyBox = dialog.locator('.lane-start-apply-now[data-apply-now="can"] input[type="checkbox"]')
    check('Start Lane for B1 offers Apply now, off, saying what it does', !!(await until(async () => (await applyBox.count()) === 1, HUNG_MS)) && !(await applyBox.isChecked()) && /puts .* back in Todo first \(its work stays on its branch\), so the new order applies at once/.test(await dialog.innerText()), await dialog.innerText().catch(() => ''))
    await applyBox.check()
    await shoot('apply-now', dialog)
    await dialog.getByRole('button', { name: /^(Start Lane|Wait and Start)$/ }).click()
    check('…applied: the dialog closes', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)), await dialog.innerText().catch(() => ''))
    check('…the card being worked is back in Todo, the lane is the new list', !!(await until(async () => (await card(d1))?.column === 'todo' && JSON.stringify((await lanes()).find((l) => l.id === third?.id)?.cards.map((x) => x.number)) === JSON.stringify([d2]), HUNG_MS)), JSON.stringify({ d1: (await card(d1))?.column, lane: (await lanes()).find((l) => l.id === third?.id) }))
    // The reordered lane's new first card: Combwork starts it on B1 too, once B1 is free (HI-2029).
    const started2 = await until(async () => (await facts(d2)).find((f) => f.kind === 'Started' && f.actor === 'combwork') ?? null, HUNG_MS)
    check('…and its new first card is started on B1 by Combwork', !!started2 && (await card(d2))?.agent === b1.id, JSON.stringify({ started2, d2: await card(d2) }))
    // That card in Review (its work committed in the slot, moved as the user does): Apply now says why it can't.
    await until(async () => (await facts(d2)).some((f) => f.kind === 'BuilderPlaced'), HUNG_MS)
    await until(quiet, HUNG_MS)
    const folder = started2?.data?.folder
    fs.writeFileSync(path.join(folder, 'now.txt'), 'now\n')
    lib.git(folder, ['add', '-A'])
    lib.git(folder, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'now'])
    const inReview = await inv('tasks:move', d2, 'review', { confirm: true, reason: 'the e2e moves it on' })
    check('…in Review', !inReview?.refused && !!(await until(async () => (await card(d2))?.column === 'review', HUNG_MS)), JSON.stringify(inReview))
    await openWithOnly(d1)
    const not = dialog.locator('.lane-start-apply-now[data-apply-now="not"]')
    check("…then Start Lane for B1 says why it can't apply now, with no checkbox", !!(await until(async () => (await not.count()) === 1, HUNG_MS)) && (await not.locator('input').count()) === 0 && /which is in Review: this list applies once it is Done/.test(await not.innerText()), await dialog.innerText().catch(() => ''))
    await shoot('apply-now-review', dialog)
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // --- HI-2029: a lane recorded through the Agent API (POST /v1/lanes, a script's) over a running, idle builder: Combwork
    // gives it the lane's first card at once, with nobody starting it (Legible's LE-259 sat in Todo for hours).
    await inv('lanes:end', third.id, true)
    const f1 = (await inv('tasks:create', { title: 'Retest installer', project: 'alpha' })).number
    await until(quiet, HUNG_MS)
    const viaApi = await fetch(`http://127.0.0.1:${PORT}/v1/lanes`, { method: 'POST', headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'alpha', builder: 'B1', reviewer: 'R1', cards: [f1] }) })
    const apiLane = await viaApi.json().catch(() => null)
    check('a lane recorded through POST /v1/lanes over B1, running and idle', viaApi.status === 200, JSON.stringify(apiLane))
    // HI-2273: started again naming a reviewer that is no agent: refused, naming its reviewer, which it keeps.
    const guessed = await fetch(`http://127.0.0.1:${PORT}/v1/lanes`, { method: 'POST', headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'alpha', builder: 'B1', reviewer: 'Reviewer', cards: [f1] }) })
    const guessedBody = await guessed.json().catch(() => null)
    check("HI-2273: its start again naming a reviewer that is no agent is refused, naming R1, which it keeps", guessed.status === 404 && /No agent "Reviewer" in alpha; this lane's reviewer is R1/.test(guessedBody?.error ?? '') && (await lanes()).find((l) => l.id === apiLane?.lane?.id)?.reviewer?.id === r1.id, JSON.stringify({ status: guessed.status, guessedBody }))
    // B1's slot is d2's (in Review): the lane says why its card waits, never "active" with nothing said.
    const apiLaneNow = async () => (await lanes()).find((l) => l.builder.id === b1.id && l.cards.some((x) => x.number === f1))
    const waits = await until(async () => (await apiLaneNow())?.status ?? null, HUNG_MS)
    check('…its card waiting for a slot, the lane says why', !!waits && (await card(f1))?.column === 'todo', JSON.stringify({ waits, lane: await apiLaneNow() }))
    // d2 put back (its slot released): Combwork starts f1 on B1 with nobody asking.
    await inv('tasks:move', d2, 'todo', { confirm: true, reason: 'the e2e puts it back' })
    // Its start refused for the slot is tried again within laneStarts.ts's RETRY_MS (30 s, by its tick), so up to two of them.
    const byCombworkF1 = await until(async () => (await facts(f1)).find((f) => f.kind === 'Started' && f.actor === 'combwork') ?? null, 2 * 30000 + HUNG_MS)
    check("…its first card is started on B1 by Combwork once the slot is free, and B1 is given it (HI-2029)", !!byCombworkF1 && (await card(f1))?.agent === b1.id && !!(await until(async () => (await facts(f1)).some((f) => f.kind === 'BuilderPlaced'), HUNG_MS)), JSON.stringify({ byCombworkF1, f1: await card(f1) }))

    // --- HI-2034: B1 owed its new conversation past its wait (as a start over a busy B1 leaves it, 11 minutes on): no
    // more tried, the lane's row says so with Retry New Conversation; Retry gives B1 its new conversation once free.
    const owedLane = await apiLaneNow()
    const before = await until(async () => (await live(b1.id))?.sessionId || null, HUNG_MS)
    check('B1 owed its new conversation for 11 minutes (lanes:test)', (await inv('lanes:test', { op: 'oweFresh', lane: owedLane?.id, role: 'builder', minutesAgo: 11 })) === true)
    const blocked = await until(async () => {
      const st = (await apiLaneNow())?.status
      return st?.why === 'fresh' && st.freshBlocked === 'timeout' ? st : null
    }, 2 * 30000 + HUNG_MS)
    check('…no more tried past its wait: the lane says so (startWait fresh, timeout)', !!blocked, JSON.stringify((await apiLaneNow())?.status ?? null))
    await page.getByRole('button', { name: 'Task Board' }).click()
    if (!(await panel.count())) await page.locator('.progress-rail').click().catch(() => undefined)
    const owedRow = panel.locator(`.progress-tab-lanes .progress-lane[data-lane="${owedLane?.id}"]`)
    const retry = owedRow.locator('[data-action="lane-retry-fresh"]')
    check("…its row offers to retry B1's new conversation, saying why", !!(await until(async () => (await retry.count()) === 1 && /B1’s new conversation didn’t start \(it wasn’t free in time\)/.test((await retry.getAttribute('aria-label')) ?? ''), HUNG_MS)), await owedRow.innerText().catch(() => ''))
    // In the panel as it opens (narrow): the reason's place is the Retry itself, "⟳ Retry B1", whole inside the header,
    // its whole reason its tooltip and accessible name, in both themes (HR1's round 2).
    const top = await owedRow.locator('.progress-lane-top').boundingBox()
    const rb = await retry.boundingBox()
    const whole = await retry.evaluate((e) => e.scrollWidth <= e.clientWidth)
    const label = (await retry.getAttribute('aria-label')) ?? ''
    check('…Retry fits the header whole, saying whose, with the whole reason on hover', !!top && !!rb && rb.x >= top.x && rb.x + rb.width <= top.x + top.width + 0.5 && whole && (await retry.innerText()).trim() === 'Retry B1' && /B1’s new conversation didn’t start \(it wasn’t free in time\)/.test(label) && label.endsWith('Retry New Conversation') && label === ((await retry.getAttribute('title')) ?? '').replace('\n', '. '), JSON.stringify({ top, rb, whole, label, text: await retry.innerText() }))
    await shoot('lane-fresh-blocked', owedRow)
    await retry.click()
    const fresh = await until(async () => {
      const id = (await live(b1.id))?.sessionId
      return id && id !== before ? id : null
    }, 2 * 30000 + HUNG_MS)
    check('…Retry: B1 is given its new conversation once free, and the row no longer offers it', !!fresh && !!(await until(async () => (await retry.count()) === 0 && (await apiLaneNow())?.status?.why !== 'fresh', HUNG_MS)), JSON.stringify({ before, fresh, status: (await apiLaneNow())?.status ?? null }))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
