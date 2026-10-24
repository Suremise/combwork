// Screenshot cases for the `workflow` area (#1126): the Version Control tab's Workflow section (the presets, a preset's
// preview, and its groups of options further down) and its Merge queue section, reached for the i18nshots route
// (#756's design, section 4) with locale-independent means only: command ids and structural hooks (data-section,
// data-vc-workflow, data-choice, data-group, classes), never English text. The git area's cases ran first and left
// alpha a repository. See tests/e2e/i18nshots.cjs for ctx.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** Waits for a locator to be gone; throws saying what stayed. */
async function gone(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) === 0, ctx.hungMs))) throw new Error(`${what} stayed open`)
}

const gitView = (ctx) => ctx.page.locator('.git-view').first()

/** The Version Control tab at a section. */
async function vcSection(ctx, id, hook, what) {
  await ctx.command('project.tab.changes')
  await (await shown(ctx, ctx.page.locator(`.git-sections [data-section="${id}"]`), `the ${id} section's tab`)).first().click()
  return shown(ctx, ctx.page.locator(hook), what)
}

/** Workflow: the presets and the first options. */
async function workflow(ctx) {
  await vcSection(ctx, 'workflow', '[data-vc-workflow] .workflow-form [data-group="presets"]', 'the Workflow section')
  await ctx.page.locator('[data-vc-workflow] [data-group="presets"]').first().scrollIntoViewIfNeeded()
  return gitView(ctx)
}

/** A preset other than the project's, opened: what it would change. */
async function preview(ctx) {
  await ctx.page.locator('[data-vc-workflow] .workflow-choice:not(.current)').first().click()
  return shown(ctx, ctx.page.locator('[data-vc-workflow] .workflow-preview'), "a preset's preview").then(() => gitView(ctx))
}

/** Its choice clicked again closes it. */
async function closePreview(ctx) {
  await ctx.page.locator('[data-vc-workflow] .workflow-choice.open').first().click()
  await gone(ctx, ctx.page.locator('[data-vc-workflow] .workflow-preview'), "the preset's preview")
}

/** A group of options further down, scrolled to the top of the page. */
const group = (id) => async (ctx) => {
  const g = await shown(ctx, ctx.page.locator(`[data-vc-workflow] [data-group="${id}"]`), `the ${id} options`)
  await g.first().evaluate((e) => e.scrollIntoView({ block: 'start' }))
  return gitView(ctx)
}

/** Merge queue: the project's queue (none waiting in the fixture). */
async function queue(ctx) {
  await vcSection(ctx, 'queue', '.git-queue:not([aria-busy])', 'the Merge queue section')
  return gitView(ctx)
}

/** Back to the Session tab for the next area's cases. */
async function closeQueue(ctx) {
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'workflow',
  screens: [
    { name: 'vc-workflow', open: workflow },
    { name: 'vc-workflow-preview', open: preview, close: closePreview },
    { name: 'vc-workflow-review', open: group('review') },
    { name: 'vc-workflow-checks', open: group('checks') },
    { name: 'vc-workflow-merging', open: group('merging') },
    { name: 'vc-workflow-where', open: group('where') },
    { name: 'vc-workflow-stages', open: group('stages') },
    { name: 'vc-queue', open: queue, close: closeQueue }
  ]
}
