// Screenshot cases for the `tips` area (#794): the tip card, the notice after "Don't show tips", and Help → Tips (its
// top, each group whole, and its search finding nothing), reached for the i18nshots route (tests/e2e/i18nshots.cjs has
// the case format) with locale-independent means only: IPC, command ids and structural hooks (data-group, data-action,
// classes), never English text.
const fs = require('fs')
const path = require('path')

const WINDOW = { width: 1400, height: 860 }
const TALLEST = 4000
const GROUPS = ['Sessions', 'Agents', 'Board', 'Assistant', 'Files', 'Shortcuts']

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

const setTips = (ctx, on) => ctx.inv('settings:update', { general: { showTips: on } })

/**
 * Next Project until the window shows the project named (its title starts with it): earlier areas' cases leave other
 * projects in the workspace (mainbeta, errorsgit), so the next one isn't always it. Throws if it never comes.
 */
async function showProject(ctx, name, what) {
  const { page, lib } = ctx
  const at = async () => (await page.title()).startsWith(name)
  for (let i = 0; i < 8 && !(await at()); i++) {
    const before = await page.title()
    await ctx.command('project.next')
    await lib.until(async () => (await page.title()) !== before, ctx.hungMs)
  }
  if (!(await lib.until(at, ctx.hungMs))) throw new Error(what)
}

/**
 * A quiet moment, as a tip waits for (HI-2320, SPEC §14 Tips; HI-2375): the window focused as Combwork sees it (earlier
 * areas leave it unfocused, as a quiet test copy really is) and no pop-up left from them. No finishes pending and no
 * agent waiting: the route's agents are stopped by then. The 10 s with no key the tip also waits for fits in hungMs.
 */
async function quietMoment(ctx) {
  const { page, lib } = ctx
  await ctx.setFocus(true)
  const close = page.locator('.toasts .toast:not(.tip-card) .popup-close')
  if (!(await lib.until(async () => (await close.count()) === 0 || (await close.first().click({ timeout: 2000 }).then(() => false, () => false)), ctx.hungMs))) throw new Error("the earlier pop-ups didn't close")
}

/**
 * The tip card: with tips on, a project of its own gets its second agent, and its session toolbar offers the second-agent
 * moment's tip (the route starts with tips off, so the moment is still unused). Its first agent is added before tips
 * are on, so the toolbar offers it only when the second one comes. It shows once the window is quiet (quietMoment).
 */
async function tipCard(ctx) {
  try {
    return await tipCardShown(ctx)
  } catch (e) {
    await ctx.setFocus(false)
    throw e
  }
}

async function tipCardShown(ctx) {
  const { inv, lib, page } = ctx
  const beta = path.join(ctx.workspace, 'tipsbeta')
  if (!fs.existsSync(beta)) {
    fs.mkdirSync(beta, { recursive: true })
    await inv('workspace:refresh')
    await lib.addAgent(inv, beta, { name: 'Tipper' })
    // A new project starts inactive: on, Next Project goes to it.
    await inv('project:setActive', beta, true)
  }
  await setTips(ctx, true)
  // The window has the setting once Help → Tips' switch shows it on: only then is the moment offered.
  await ctx.command('help.tips')
  await shown(ctx, page.locator('.tips-switch .switch.on'), "Help → Tips' switch on")
  if (!(await lib.until(async () => (await page.locator('.tips-list').count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("Help → Tips didn't close")
  // The other project, shown, then its second agent.
  await showProject(ctx, 'tipsbeta', 'the other project was not selected')
  await ctx.command('project.tab.session')
  await quietMoment(ctx)
  await lib.addAgent(inv, beta, { name: 'Tipster' })
  return shown(ctx, page.locator('.tip-card'), 'the tip card')
}

/** "Don't show tips" on the card: the notice that says where they still are. */
async function tipsOff(ctx) {
  const { page } = ctx
  try {
    await (await shown(ctx, page.locator('.tip-card .tip-off'), "the card's Don't show tips")).click()
    return await shown(ctx, page.locator('.toasts .toast'), 'the notice that tips are off')
  } catch (e) {
    await ctx.setFocus(false)
    throw e
  }
}

async function closeNotice(ctx) {
  const { page, lib } = ctx
  const dismiss = () => page.locator('.toasts .toast .icon-btn').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.toasts .toast').count()) === 0 || (await dismiss()), ctx.hungMs))) throw new Error("the notice didn't close")
  await setTips(ctx, false)
  // Unfocused again, as the areas after it expect.
  await ctx.setFocus(false)
  // Back to alpha.
  await showProject(ctx, path.basename(ctx.project), 'alpha was not selected again')
}

/** Help → Tips, open. */
async function openTips(ctx) {
  if (!(await ctx.page.locator('.tips-list').count())) await ctx.command('help.tips')
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('.tips-list') }), 'Help → Tips')
}

async function closeTips(ctx) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator('.tips-list').count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("Help → Tips didn't close")
  await lib.fitWindow(ctx.app, page, WINDOW)
}

/** A group of Help → Tips, whole: the window made tall enough for its section. */
const groupScreen = (group) => ({
  name: `group-${group.toLowerCase()}`,
  open: async (ctx) => {
    const { page, lib, app } = ctx
    await lib.fitWindow(app, page, { width: WINDOW.width, height: TALLEST })
    await openTips(ctx)
    const section = await shown(ctx, page.locator(`.tips-list section[data-group="${group}"]`), `Help → Tips' ${group} group`)
    await section.scrollIntoViewIfNeeded()
    return section
  }
})

/** Help → Tips searched for what no tip says: its "No tips match". */
async function noMatch(ctx) {
  const dialog = await openTips(ctx)
  await dialog.locator('input').first().fill('zzzz qqqq')
  await shown(ctx, dialog.locator('.pane-empty'), "Help → Tips' empty search")
  return dialog
}

module.exports = {
  area: 'tips',
  screens: [
    { name: 'card', open: tipCard },
    { name: 'off-notice', open: tipsOff, close: closeNotice },
    { name: 'dialog', open: openTips },
    ...GROUPS.map(groupScreen),
    { name: 'no-match', open: noMatch, close: closeTips }
  ]
}
