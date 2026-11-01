// Screenshot cases for the `board` area (#798): the task board, a card's dialog and menu, the archive, the attention
// inbox, the Progress panel's lanes and merge card, and the project's merge slot, reached for the i18nshots route
// (#756's design, section 4) with locale-independent means only: IPC, the Agent API, command ids and structural hooks
// (data-task, data-inbox-toggle, classes), never English text. See tests/e2e/i18nshots.cjs for the case format and ctx.
const fs = require('fs')
const path = require('path')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** Escape until nothing of `selector` is left (a dialog, a menu, the inbox). */
async function dismiss(ctx, selector, what) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator(selector).count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error(`${what} didn't close`)
}

/** The live sessions of the case's agents (null where none). */
const liveOf = async (ctx, agents) => {
  const live = await ctx.inv('session:live')
  return agents.map((a) => live.find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === a.id) ?? null)
}

/** Starts agents (the fake Claude Code) and waits for them to be ready. */
async function start(ctx, agents) {
  for (const a of agents) await ctx.inv('session:start', ctx.project, { agentId: a.id })
  if (!(await ctx.lib.until(async () => (await liveOf(ctx, agents)).every((s) => s?.status === 'ready'), ctx.hungMs))) throw new Error(`the agents did not start: ${JSON.stringify((await liveOf(ctx, agents)).map((s) => s?.status))}`)
}

/** An agent's Agent API token, from the fake Claude Code's record of its launches (its running session's). */
async function tokenOf(ctx, agent) {
  const [live] = await liveOf(ctx, [agent])
  const launches = fs.readFileSync(path.join(ctx.claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const token = launches.filter((l) => l.sessionId === live?.sessionId).at(-1)?.token
  if (!token) throw new Error(`no API token for ${agent.name} (session ${live?.sessionId})`)
  return token
}

/** The Agent API as one agent (its own token), on the test copy's port (the route's, lib.port). */
async function apiAs(ctx, token, method, route, body) {
  const r = await fetch(`http://127.0.0.1:${ctx.lib.port(47834)}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const json = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${JSON.stringify(json)}`)
  return json
}

/**
 * The task board with a card in every column: one On Hold with its reason, one blocked, one in Active whose agent isn't
 * running (stalled), one in Review, Approved and Done, and one archived for the archive's screen.
 */
async function board(ctx) {
  const { page, inv, agents, project } = ctx
  const name = project.split(/[\\/]/).pop()
  const three = agents[2]
  const make = async (title, column, extra = {}) => (await inv('tasks:create', { title, project: name, column, ...extra })).number
  const cards = (ctx.boardCards = {})
  cards.hold = await make('Parked idea', 'hold')
  await inv('tasks:update', cards.hold, { blocked: 'Waiting for the release' })
  // The user's reason, though it fits a message's pattern ("Waiting for {what}"): not English left.
  ctx.authored('Waiting for the release', '.task-blocked')
  cards.todo = await make('Next thing', 'todo')
  cards.blocked = await make('Needs a decision', 'todo')
  await inv('tasks:update', cards.blocked, { blocked: 'Which colour?' })
  cards.doing = await make('Work in progress', 'doing', { agent: three.id })
  cards.review = await make('Ready for review', 'review')
  cards.passed = await make('Reviewed work', 'passed')
  cards.done = await make('Merged work', 'done')
  cards.archived = await make('Old work', 'done')
  await inv('tasks:archive', cards.archived, true)
  // An Archive All batch, named as the dialog names one (in English, as it is stored): the archive's picker words it.
  cards.batch = await make('Older work', 'done')
  await inv('tasks:archiveBatch', [cards.batch], { label: 'All in Done', column: 'done', project: name, query: '', includeBusy: false })
  await ctx.command('view.board')
  const view = page.locator('.board-view').first()
  await shown(ctx, view.locator(`.task-card[data-task="${cards.done}"]`), 'the board with its cards')
  return view
}

/** A card's dialog: the stalled card in Doing. */
async function cardDialog(ctx) {
  const { page } = ctx
  await page.locator(`.board-view .task-card[data-task="${ctx.boardCards.doing}"]`).first().click()
  return (await shown(ctx, page.locator('.dialog[role="dialog"]'), "the card's dialog")).first()
}

/** A card's menu (right-click on the card in Review). */
async function cardMenu(ctx) {
  const { page } = ctx
  await page.locator(`.board-view .task-card[data-task="${ctx.boardCards.review}"]`).first().click({ button: 'right' })
  return (await shown(ctx, page.locator('.menu[role="menu"]'), "the card's menu")).first()
}

/** The toolbar's Archived checkbox: the one that isn't For you's (#1276's filter, which comes first). */
const archivedBox = (page) => page.locator('.board-view .board-toolbar label:not(.board-for-you-filter) input.checkbox').first()

/** The archive: the board's archived cards (the toolbar's checkbox). */
async function archive(ctx) {
  const { page } = ctx
  const box = archivedBox(page)
  await shown(ctx, box, "the board's archived checkbox")
  await box.check()
  await shown(ctx, page.locator('.board-view .archived-cards tbody tr'), 'the archived cards')
  // The Archive All batch chosen in the batch picker, so its name shows (the picker's first choice is every card).
  const picker = (await shown(ctx, page.locator('.board-view .archive-batch select'), "the archive's batch picker")).first()
  await picker.selectOption({ index: 1 })
  return page.locator('.board-view').first()
}

async function closeArchive(ctx) {
  await ctx.page.locator('.board-view .archive-batch select').first().selectOption({ index: 0 })
  await archivedBox(ctx.page).uncheck()
}

/** The attention inbox: Two finishes a turn nobody has looked at (the window shows the board, not its pane). */
async function inbox(ctx) {
  const { page, inv, lib, agents, project } = ctx
  const two = agents[1]
  await start(ctx, [two])
  const prompts = lib.fakePrompts(inv, lib.ptyKey(project, two.id), async () => (await liveOf(ctx, [two]))[0], { home: ctx.claudeHome })
  if (!(await prompts.over(await prompts.type('hello')))) throw new Error("Two's turn did not end")
  const toggle = await shown(ctx, page.locator('[data-inbox-toggle]'), "the status bar's inbox")
  await toggle.first().click()
  return (await shown(ctx, page.locator('.inbox-panel'), 'the inbox')).first()
}

/**
 * The Progress panel's lanes and merge card: One builds and Two reviews the board's cards (a lane started through the
 * Agent API, as the Assistant does); One holds the merge slot for main, running a test set, with Two waiting for it.
 */
async function lanes(ctx) {
  const { page, agents, project } = ctx
  const [one, two] = agents
  await start(ctx, [one])
  const c = ctx.boardCards
  const name = project.split(/[\\/]/).pop()
  // One, an idle builder outside slots, is given the lane in a new conversation (HI-2232), so a new launch and token. Quiet
  // first (idle, nothing of Hive's being typed into it or waiting to be), or it would be left as it is mid-turn, or its
  // new conversation owed until it is free (HI-2252).
  const twoToken = await tokenOf(ctx, two)
  const port = ctx.lib.port(47834)
  if (!(await ctx.lib.until(async () => ctx.lib.agentQuiet(port, name, (await liveOf(ctx, [one]))[0], twoToken), ctx.hungMs))) throw new Error(`One wasn't quiet before its lane: ${JSON.stringify((await liveOf(ctx, [one]))[0])}`)
  const [before] = await liveOf(ctx, [one])
  await ctx.api('POST', '/v1/lanes', { project: name, builder: one.name, reviewer: two.name, name: 'i18n lane', cards: [c.done, c.passed, c.review, c.doing, c.blocked, c.todo] })
  const renewed = async () => {
    const [now] = await liveOf(ctx, [one])
    return !!now && now.sessionId !== before?.sessionId && ['ready', 'finished'].includes(now.status) && !!(await tokenOf(ctx, one).catch(() => null))
  }
  if (!(await ctx.lib.until(renewed, ctx.hungMs))) throw new Error(`One didn't get its lane in a new conversation: ${JSON.stringify((await liveOf(ctx, [one]))[0])}`)
  ctx.tokens = { one: await tokenOf(ctx, one), two: twoToken }
  await apiAs(ctx, ctx.tokens.one, 'POST', '/v1/progress', { title: 'Full test set', total: 146, step: 112, stepName: 'mergeslot', estimateMs: 600000 })
  await apiAs(ctx, ctx.tokens.one, 'POST', `/v1/projects/${name}/merge-slot/claim`, { branch: 'main', cards: [c.passed], timeoutSeconds: 0 })
  await apiAs(ctx, ctx.tokens.two, 'POST', `/v1/projects/${name}/merge-slot/claim`, { branch: 'main', cards: [c.review], timeoutSeconds: 0 })
  const panel = page.locator('.progress-panel')
  if (!(await panel.count())) await ctx.command('progress.toggle')
  await shown(ctx, panel.locator('.progress-merge-card'), 'the merge card')
  await shown(ctx, panel.locator('.progress-lanes'), 'the lanes')
  return panel.first()
}

/** The project's merge slot, on its Overview tab: held by One, Two waiting. */
async function mergeSlots(ctx) {
  await ctx.command('project.tab.overview')
  return (await shown(ctx, ctx.page.locator('.merge-slots'), 'the merge slot')).first()
}

/** Gives the slot back, stops the agents and goes back to the agents' tab. */
async function closeMergeSlots(ctx) {
  const { agents, project } = ctx
  const name = project.split(/[\\/]/).pop()
  await apiAs(ctx, ctx.tokens.two, 'POST', `/v1/projects/${name}/merge-slot/release`, { branch: 'main' }).catch(() => null)
  await apiAs(ctx, ctx.tokens.one, 'POST', `/v1/projects/${name}/merge-slot/release`, { branch: 'main' })
  for (const a of agents.slice(0, 2)) await ctx.inv('session:stop', project, a.id)
  if (!(await ctx.lib.until(async () => (await liveOf(ctx, agents.slice(0, 2))).every((s) => !s || s.status === 'stopped' || s.status === 'exited'), ctx.hungMs))) throw new Error("the agents didn't stop")
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'board',
  screens: [
    { name: 'board', open: board },
    { name: 'card-dialog', open: cardDialog, close: (ctx) => dismiss(ctx, '.dialog[role="dialog"]', "the card's dialog") },
    { name: 'card-menu', open: cardMenu, close: (ctx) => dismiss(ctx, '.menu[role="menu"]', "the card's menu") },
    { name: 'archive', open: archive, close: closeArchive },
    { name: 'inbox', open: inbox, close: (ctx) => dismiss(ctx, '.inbox-panel', 'the inbox') },
    { name: 'lanes', open: lanes },
    { name: 'merge-slots', open: mergeSlots, close: closeMergeSlots }
  ]
}
