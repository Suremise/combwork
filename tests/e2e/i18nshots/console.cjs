// Screenshot cases for the `console` area (#1104): the developer console's window, with no source chosen and then
// watching the first agent. Reached for the i18nshots route (#756's design, section 4) with locale-independent means
// only: IPC (console:open), the window's #console address and structural hooks (classes), never English text. The
// themes are the main window's settings, which the console follows. See tests/e2e/i18nshots.cjs for ctx.

/** The developer console's window, once it has drawn its toolbar; throws when it doesn't open. */
async function consoleWindow(ctx) {
  const find = () => ctx.app.windows().find((w) => w.url().endsWith('#console')) ?? null
  // The console opens only with Settings → Advanced → Show developer features on (closeConsole turns it off again).
  if (!find()) {
    await ctx.inv('settings:update', { advanced: { showDeveloperFeatures: true } })
    await ctx.inv('console:open')
  }
  const win = await ctx.lib.until(find, ctx.hungMs)
  if (!win) throw new Error("the developer console's window did not open")
  if (!(await ctx.lib.until(async () => (await win.locator('.dc-toolbar').count()) > 0, ctx.hungMs))) throw new Error("the developer console's toolbar did not show")
  // In the main window's language (#1104: it once couldn't ask for it, and showed English in every language).
  const lang = await ctx.page.evaluate(() => document.documentElement.lang)
  if (!(await ctx.lib.until(async () => (await win.evaluate(() => document.documentElement.lang)) === lang, ctx.hungMs))) throw new Error(`the developer console's window is not in the window's language (${lang})`)
  return win
}

/** Closes the console's window, if it is open. */
async function closeConsole(ctx) {
  for (const w of ctx.app.windows().filter((x) => x.url().endsWith('#console'))) await w.close()
  await ctx.inv('settings:update', { advanced: { showDeveloperFeatures: false } })
}

module.exports = {
  area: 'console',
  screens: [
    {
      name: 'window',
      open: async (ctx) => {
        const win = await consoleWindow(ctx)
        await win.locator('.dc-source').selectOption({ index: 0 })
        return win.locator('.dc')
      }
    },
    {
      // The flight recorder's captures (#698): the list, empty in a new profile, says how to turn a trigger on.
      name: 'captures',
      open: async (ctx) => {
        const win = await consoleWindow(ctx)
        await win.locator('.dc-captures').click()
        if (!(await ctx.lib.until(async () => (await win.locator('.dc-captures-menu').count()) > 0, ctx.hungMs))) throw new Error("the console's list of captures did not show")
        return win.locator('.dc')
      },
      close: async (ctx) => {
        const win = await consoleWindow(ctx)
        await win.locator('.dc-captures').click()
      }
    },
    {
      name: 'source',
      open: async (ctx) => {
        const win = await consoleWindow(ctx)
        // The first source after the empty choice: an agent or Combwork, whatever the language names them.
        const options = await win.locator('.dc-source option').count()
        if (options < 2) throw new Error('the console offered no source')
        await win.locator('.dc-source').selectOption({ index: 1 })
        return win.locator('.dc')
      },
      close: closeConsole
    }
  ]
}
