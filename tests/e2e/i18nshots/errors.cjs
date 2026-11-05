// Screenshot cases for the `errors` area (#845): a call the main process refuses (ipc.ts's CombworkErrors) as the window
// shows it, in the run's language, reached for the i18nshots route (tests/e2e/i18nshots.cjs has the case format) with
// locale-independent means only: IPC, command ids and structural hooks, never English text. Windows draws the native
// dialogs' titles, so they can't be photographed here.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** A project of its own, in git, whose .gitignore brings .combwork back: git goes on seeing .combwork however it's excluded. */
const projectOf = (ctx) => path.join(ctx.workspace, 'errorsgit')

/**
 * The .combwork notice's Exclude, refused: main says why (errors.cw.notIgnored), and the window shows it in a notice in
 * its language.
 */
async function excludeRefused(ctx) {
  const { page, inv } = ctx
  const dir = projectOf(ctx)
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.gitignore'), '!.combwork/\n')
    execFileSync('git', ['init', '-q'], { cwd: dir, env: ctx.lib.gitEnv(), stdio: 'pipe' })
  }
  await inv('workspace:refresh')
  await inv('project:setActive', dir, true)
  await ctx.command('project.focus', dir)
  await ctx.command('project.tab.settings')
  await page.mouse.move(5, 5)
  const exclude = await shown(ctx, page.locator('.hive-vcs-notice button.primary'), "the .combwork notice's Exclude")
  await exclude.click()
  return shown(ctx, page.locator('.toasts .toast.error'), 'the refusal')
}

/** The notice closed, the project off again (cases after this one count the projects that are on), and alpha shown. */
async function closeRefused(ctx) {
  const { page, lib, inv } = ctx
  const dismiss = () => page.locator('.toasts .toast .icon-btn').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.toasts .toast').count()) === 0 || (await dismiss()), ctx.hungMs))) throw new Error("the refusal didn't close")
  await ctx.command('project.focus', ctx.project)
  await inv('project:setActive', projectOf(ctx), false)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'errors',
  screens: [{ name: 'exclude-refused', open: excludeRefused, close: closeRefused }]
}
