// Screenshot cases for the `shell` area (#795): the title bar's menus (each open), the title bar at the narrowest
// window (#1038), the command palette, the
// notifications panel, Help → About, Copy Diagnostics, Keyboard Shortcuts and Provider Setup, the Compact dialog and the
// quit dialog, reached for the i18nshots route (tests/e2e/i18nshots.cjs has the case format) with locale-independent
// means only: IPC, command ids and structural hooks (data-menu, data-command, classes), never English text.

const MENUS = ['file', 'edit', 'view', 'project', 'session', 'help']

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** Escape until nothing of `selector` is left (a dialog, the palette, a menu). */
async function escapeFrom(ctx, selector, what) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator(selector).count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error(`${what} didn't close`)
}

/** A menu of the title bar, open: the menu bar and the menu under it, together. */
const menuScreen = (id) => ({
  name: `menu-${id}`,
  open: async (ctx) => {
    const { page } = ctx
    await (await shown(ctx, page.locator(`.menubar [data-menu="${id}"]`), `the ${id} menu`)).click()
    await shown(ctx, page.locator('.menu [data-command], .menu .menu-item'), `the ${id} menu's items`)
    return null
  },
  close: (ctx) => escapeFrom(ctx, 'body > .menu', `the ${id} menu`)
})

/** A dialog a command opens, photographed. */
const dialogScreen = (name, command, what, close = (ctx) => escapeFrom(ctx, '.dialog', what)) => ({
  name,
  open: async (ctx) => {
    await ctx.command(command)
    return shown(ctx, ctx.page.locator('.dialog').last(), what)
  },
  close
})

/** The live sessions of alpha's first agent. */
const firstLive = async (ctx) => (await ctx.inv('session:live')).find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === ctx.agents[0].id)

/** Alpha's first agent running and ready, for the Compact and quit dialogs. */
async function startFirst(ctx) {
  if ((await firstLive(ctx))?.status === 'ready') return
  await ctx.inv('session:start', ctx.project, { agentId: ctx.agents[0].id })
  if (!(await ctx.lib.until(async () => (await firstLive(ctx))?.status === 'ready', ctx.hungMs))) throw new Error(`One did not start: ${JSON.stringify(await firstLive(ctx))}`)
}

async function stopFirst(ctx) {
  await ctx.inv('session:stop', ctx.project, ctx.agents[0].id)
  // One read per check (#868): the session can go between two reads, and a second read's undefined threw.
  const stopped = async () => {
    const s = await firstLive(ctx)
    return !s || ['stopped', 'exited'].includes(s.status)
  }
  if (!(await ctx.lib.until(stopped, ctx.hungMs))) throw new Error(`One didn't stop: ${JSON.stringify(await firstLive(ctx))}`)
}

/** Compact for alpha's first agent: shown with its facts once the agent is ready. */
async function compact(ctx) {
  await ctx.command('project.tab.session')
  await startFirst(ctx)
  // Compact runs for the focused agent's live session: One, the first.
  await ctx.command('agent.focus1')
  await ctx.command('session.compact', ctx.project, ctx.agents[0].id)
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('.compact-focus, .compact-facts') }), 'the Compact dialog')
}

/**
 * The quit dialog with a session running: asked for (Settings → General → Confirm before quitting: always), checked in
 * main first, so the quit can never go ahead without the dialog; cancelled again by its close.
 */
async function quit(ctx) {
  const { inv, lib, page } = ctx
  await startFirst(ctx)
  await inv('settings:update', { general: { confirmOnQuit: 'always' } })
  if ((await inv('settings:get')).general.confirmOnQuit !== 'always') throw new Error('Confirm before quitting is not on: not quitting')
  if (!(await firstLive(ctx))) throw new Error('no session running: not quitting')
  await inv('app:quit')
  await shown(ctx, page.locator('.dialog .quit-agents'), 'the quit dialog')
  if (!(await lib.until(async () => (await inv('app:quitState')).request !== null, ctx.hungMs))) throw new Error("the quit isn't waiting for the dialog")
  return page.locator('.dialog').last()
}

async function closeQuit(ctx) {
  const { inv, lib, page } = ctx
  if (!(await lib.until(async () => (await inv('app:quitState')).request === null || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("the quit dialog didn't cancel")
  await inv('settings:update', { general: { confirmOnQuit: 'never' } })
  await stopFirst(ctx)
}

/** The command palette, with every command. */
async function palette(ctx) {
  await ctx.command('palette.show')
  await shown(ctx, ctx.page.locator('.palette .palette-item[data-command]'), "the palette's commands")
  return ctx.page.locator('.palette').first()
}

/** The palette searched for what no command or project is called. */
async function paletteEmpty(ctx) {
  await ctx.command('palette.show')
  const box = await shown(ctx, ctx.page.locator('.palette input'), "the palette's box")
  await box.fill('zzzz qqqq')
  await shown(ctx, ctx.page.locator('.palette .pane-empty'), "the palette's empty list")
  return ctx.page.locator('.palette').first()
}

/** The notifications panel, empty. */
async function notifications(ctx) {
  await ctx.command('view.notifications')
  return shown(ctx, ctx.page.locator('.notif-panel'), 'the notifications panel')
}

/** Where the title bar's menu bar, title and pin are, in the page: the title's null while it's hidden. */
const titleBarLayout = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el || getComputedStyle(el).visibility === 'hidden') return null
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    }
    return { width: window.innerWidth, menubar: box('.titlebar .menubar'), title: box('.titlebar-title'), actions: box('.titlebar-actions') }
  })

/**
 * The title bar at the narrowest window, 900 × 650 (#1038): the window title gives way to the menu bar (shortened with
 * an ellipsis, or hidden) rather than running into it, as German's "Hilfe" ran into "alpha". Throws while they overlap.
 */
async function titleBarNarrow(ctx) {
  const { app, page, lib } = ctx
  await lib.fitWindow(app, page, { width: 900, height: 650 })
  let layout = null
  const clear = async () => {
    layout = await titleBarLayout(page)
    const { width, menubar, title, actions } = layout
    return width === 900 && !!menubar && !!actions && (!title || (title.left >= menubar.right && title.right <= actions.left))
  }
  if (!(await lib.until(clear, ctx.hungMs))) throw new Error(`the window title overlaps the menu bar or the pin at 900 px: ${JSON.stringify(layout)}`)
  return page.locator('.titlebar')
}

module.exports = {
  area: 'shell',
  screens: [
    ...MENUS.map(menuScreen),
    {
      name: 'titlebar-narrow',
      open: titleBarNarrow,
      close: async (ctx) => {
        await ctx.lib.fitWindow(ctx.app, ctx.page, { width: 1400, height: 860 })
        if (!(await ctx.lib.until(async () => (await ctx.page.evaluate(() => window.innerWidth)) === 1400, ctx.hungMs))) throw new Error("the window didn't go back to 1400 px")
      }
    },
    { name: 'palette', open: palette, close: (ctx) => escapeFrom(ctx, '.palette', 'the palette') },
    { name: 'palette-empty', open: paletteEmpty, close: (ctx) => escapeFrom(ctx, '.palette', 'the palette') },
    {
      name: 'notifications',
      open: notifications,
      close: async (ctx) => {
        await (await shown(ctx, ctx.page.locator('.notif-panel .pane-header .icon-btn').last(), "the panel's close")).click()
        if (!(await ctx.lib.until(async () => (await ctx.page.locator('.notif-panel').count()) === 0, ctx.hungMs))) throw new Error("the panel didn't close")
      }
    },
    dialogScreen('about', 'help.about', 'Help → About'),
    dialogScreen('diagnostics', 'help.diagnostics', 'Copy Diagnostics'),
    dialogScreen('shortcuts', 'help.shortcuts', 'Keyboard Shortcuts'),
    dialogScreen('agent-setup', 'help.agentSetup', 'Provider Setup'),
    { name: 'compact', open: compact, close: (ctx) => escapeFrom(ctx, '.dialog', 'the Compact dialog') },
    { name: 'quit', open: quit, close: closeQuit }
  ]
}
