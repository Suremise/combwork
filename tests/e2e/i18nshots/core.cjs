// Screenshot cases for the i18nshots route's core screens (#769; #756's design, section 4): the screens the i18n
// prototype translated, reached with locale-independent means only: IPC, the Agent API, command ids and structural
// hooks (data-stat, data-run, data-agent, data-action, classes), never English text. The route runs them first, in this
// order, in one window per language: see tests/e2e/i18nshots.cjs for the case format and what ctx holds.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** The Usage tab's figures, with the cost (Intl currency). */
async function usageCost(ctx) {
  await ctx.command('project.tab.overview')
  const cost = await shown(ctx, ctx.page.locator('.card[data-stat="cost"]').first(), "the Usage tab's cost")
  return ctx.page.locator('.cards', { has: cost }).first()
}

/** The live sessions of the project's agents, in the fixture's order. */
const liveOf = async (ctx) => {
  const live = await ctx.inv('session:live')
  return ctx.agents.map((a) => live.find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === a.id))
}

/** The in-app banners: the three agents finish a turn together while the window is focused. */
async function banner(ctx) {
  const { inv, lib, agents, project } = ctx
  for (const a of agents) await inv('session:start', project, { agentId: a.id })
  if (!(await lib.until(async () => (await liveOf(ctx)).every((s) => s?.status === 'ready'), ctx.hungMs))) throw new Error(`the agents did not start: ${JSON.stringify((await liveOf(ctx)).map((s) => s?.status))}`)
  await ctx.setFocus(true)
  // Typed to each before any turn ends, so they finish close together (one banner for the three, when they do).
  const prompts = agents.map((a, i) => lib.fakePrompts(inv, lib.ptyKey(project, a.id), async () => (await liveOf(ctx))[i], { home: ctx.claudeHome }))
  const typed = []
  for (const p of prompts) typed.push(await p.type('hello'))
  for (const [i, p] of prompts.entries()) if (!(await p.over(typed[i]))) throw new Error(`${agents[i].name}'s turn did not end`)
  return shown(ctx, ctx.page.locator('.popups').filter({ has: ctx.page.locator('.popup.kind-finished') }).first(), 'a pop-up')
}

async function closeBanner(ctx) {
  const { page, lib, inv, agents, project } = ctx
  const close = page.locator('.popups .popup-close')
  if (!(await lib.until(async () => (await close.count()) === 0 || (await close.first().click({ timeout: 2000 }).then(() => false, () => false)), ctx.hungMs))) throw new Error("the banners didn't close")
  await ctx.setFocus(false)
  for (const a of agents) await inv('session:stop', project, a.id)
  if (!(await lib.until(async () => (await liveOf(ctx)).every((s) => !s || s.status === 'stopped' || s.status === 'exited'), ctx.hungMs))) throw new Error("the agents didn't stop")
}

/** The Progress panel with runs in several states (reported through the Agent API, as a script does), one opened. */
async function progress(ctx) {
  const { page, api } = ctx
  const failed = (await api('POST', '/v1/progress', { title: 'typecheck', command: 'npm run typecheck' })).id
  await api('POST', `/v1/progress/${failed}/finish`, { ok: false, summary: 'src/main/i18n.ts(12,3): error TS2304', exitCode: 2 })
  const passed = (await api('POST', '/v1/progress', { title: 'lint', command: 'npm run lint' })).id
  await api('POST', `/v1/progress/${passed}/finish`, { ok: true })
  await api('POST', '/v1/progress', { title: 'unit tests', command: 'npm test', waiting: 'a test slot' })
  await api('POST', '/v1/progress', { title: 'e2e: full set before the release', command: 'npm run e2e -- --all', total: 12, step: 4, stepName: 'carddialog', estimateMs: 6 * 60_000 })
  const panel = page.locator('.progress-panel')
  if (!(await panel.count())) await ctx.command('progress.toggle')
  await shown(ctx, panel.locator('.progress-run'), 'the Progress panel with its runs')
  if (!(await ctx.lib.until(async () => (await panel.locator('[data-run]').count()) >= 4, ctx.hungMs))) throw new Error(`the Progress panel shows ${await panel.locator('[data-run]').count()} of 4 runs`)
  await panel.locator(`[data-run="${failed}"]`).first().click()
  await shown(ctx, panel.locator('.progress-details'), "the failed run's details")
  return panel.first()
}

/** The whole window: the project's agents, with the Progress panel open. */
async function wholeWindow(ctx) {
  await ctx.command('project.tab.session')
  await shown(ctx, ctx.page.locator('.progress-panel'), 'the Progress panel')
  return null
}

/** Removing an agent with open cards asks what becomes of them (a choice dialog listing the cards). */
async function openCards(ctx) {
  const { page, inv, lib, project } = ctx
  // An agent of its own, never started, so removing it asks nothing about a running session.
  const four = (ctx.cardsAgent ??= await lib.addAgent(inv, project, { name: 'Four' }))
  const name = project.split(/[\\/]/).pop()
  const cards = []
  for (const [title, column] of [['Add a greeting', 'doing'], ['Translate the Progress panel', 'todo'], ['Polish plurals', 'todo']]) cards.push(await inv('tasks:create', { title, project: name, agent: four.id, column }))
  // The window has them once Four's pane header shows its card in Doing (the dialog reads the window's cards); Four is
  // shown from the summary chip's list (#975), which names agents as they are, in any language.
  await ctx.command('project.tab.session')
  await lib.showAgent(page, 'Four')
  await shown(ctx, lib.paneHeader(page, 'Four').locator(`[data-task="${cards[0].number}"]`).first(), "Four's card on its pane header")
  // The agents are listed in Project Settings' Agents section (its people icon), not the section it opens on.
  await ctx.command('project.tab.settings')
  await (await shown(ctx, page.locator('.settings-nav .row', { has: page.locator('.codicon-organization') }), 'the Agents section')).first().click()
  const remove = await shown(ctx, page.locator(`[data-agent="${four.id}"] [data-action="remove-agent"]`).first(), "Four's remove button")
  await remove.click()
  // First "Remove Four?": its action button is the solid (or danger, or primary) one, whatever its words.
  const confirm = await shown(ctx, page.locator('.dialog').last().locator('button.solid, button.danger, button.primary').last(), 'the remove dialog')
  await confirm.click()
  // Then the open cards, listed by their label: the project's key where it has one ("AL-1"), else the number (#1318).
  const label = cards[0].key || `#${cards[0].number}`
  const ask = page.locator('.dialog').last()
  if (!(await lib.until(async () => (await ask.innerText().catch(() => '')).includes(label), ctx.hungMs))) throw new Error(`the open-cards dialog did not show ${label} (dialogs: ${await page.locator('.dialog').count()}; the last says: ${JSON.stringify((await ask.innerText().catch(() => '')).slice(0, 160))})`)
  return ask
}

/** Its Cancel (the first subtle button): Four and its cards stay. */
async function closeDialog(ctx) {
  const { page, lib } = ctx
  const cancel = () => page.locator('.dialog').last().locator('button.subtle').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("the dialog didn't close")
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'core',
  screens: [
    { name: 'usage-cost', open: usageCost, close: (ctx) => ctx.command('project.tab.session') },
    { name: 'banner', open: banner, close: closeBanner },
    { name: 'progress', open: progress },
    { name: 'window', open: wholeWindow },
    { name: 'open-cards-dialog', open: openCards, close: closeDialog }
  ]
}
