// Screenshot cases for the `performance` area (#1104): the workspace's Performance view (its top, and scrolled to the
// end, where the notes on what isn't measured are), a project's Performance tab, and Performance → Compare. Reached for
// the i18nshots route (#756's design, section 4) with locale-independent means only: command ids and structural hooks
// (classes), never English text. See tests/e2e/i18nshots.cjs for ctx.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

const page = (ctx) => ctx.page.locator('.performance-page')
/** The Now/Compare switch: its buttons, Now first. */
const views = (ctx) => page(ctx).locator('.board-header .segmented button')

/** Shows the workspace's Performance view on Now, scrolled to its top or its end. */
async function workspace(ctx, end) {
  await ctx.command('view.performance')
  await shown(ctx, page(ctx).locator('.perf-controls'), 'the Performance view')
  await views(ctx).first().click()
  await page(ctx).evaluate((el, toEnd) => el.scrollTo(0, toEnd ? el.scrollHeight : 0), end)
  return null
}

module.exports = {
  area: 'performance',
  screens: [
    { name: 'workspace', open: (ctx) => workspace(ctx, false) },
    { name: 'workspace-end', open: (ctx) => workspace(ctx, true), close: (ctx) => page(ctx).evaluate((el) => el.scrollTo(0, 0)) },
    {
      name: 'compare',
      open: async (ctx) => {
        await ctx.command('view.performance')
        await shown(ctx, views(ctx), 'the Now/Compare switch')
        await views(ctx).nth(1).click()
        await shown(ctx, page(ctx).locator('.board-header .segmented button.active').nth(0), 'Compare chosen')
        if (!(await ctx.lib.until(async () => (await views(ctx).nth(1).getAttribute('aria-pressed')) === 'true', ctx.hungMs))) throw new Error('Compare did not open')
        return null
      },
      close: (ctx) => views(ctx).first().click()
    },
    {
      // Two views kept without a name, project agents' and scripts', compared: the names and descriptions Combwork gives them,
      // and why they can't be compared (their Who filters), all in the language (#1104).
      name: 'compare-filters',
      open: async (ctx) => {
        const scope = { kind: 'workspace' }
        const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() }
        const base = await ctx.inv('benchmarks:keep', { scope, role: 'agent', ...range }, '')
        const run = await ctx.inv('benchmarks:keep', { scope, role: 'api', ...range }, '')
        ctx.kept = [base.id, run.id]
        await ctx.inv('benchmarks:select', scope, base.id, run.id)
        await ctx.command('view.performance')
        await shown(ctx, views(ctx), 'the Now/Compare switch')
        await views(ctx).first().click()
        await views(ctx).nth(1).click()
        await shown(ctx, page(ctx).locator('.perf-comparison .perf-pair'), 'the comparison of the two kept views')
        return null
      },
      close: async (ctx) => {
        const scope = { kind: 'workspace' }
        await ctx.inv('benchmarks:select', scope, null, null)
        for (const id of ctx.kept ?? []) await ctx.inv('benchmarks:remove', scope, id)
        await views(ctx).first().click()
      }
    },
    {
      name: 'project-tab',
      open: async (ctx) => {
        await ctx.command('project.tab.performance')
        await shown(ctx, ctx.page.locator('.tab-body .performance-page .perf-controls'), "the project's Performance tab")
        return null
      },
      close: (ctx) => ctx.command('project.tab.session')
    }
  ]
}
