// Screenshot cases for the `worktrees` area (#848): why an unused worktree isn't reused, as the Add Agent dialog says it
// in the run's language (main words it: projectAgents.ts), reached for the i18nshots route (tests/e2e/i18nshots.cjs has
// the case format and ctx) with locale-independent means only: IPC, command ids and structural hooks (data-worktree-match,
// classes), never English text. The area's refusals reach the window through IPC, which tests/i18n/worktrees.test.ts
// checks in another language.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** A project of its own, in git, on main. */
const projectOf = (ctx) => path.join(ctx.workspace, 'wtgit')
/** Its unused worktree, in the workspace's worktrees folder, on hive/held with a commit main doesn't have. */
const treeOf = (ctx) => path.join(path.dirname(ctx.workspace), `${path.basename(ctx.workspace)}.worktrees`, 'wtgit', 'held')

function git(ctx, cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, env: ctx.lib.gitEnv(), stdio: 'pipe', encoding: 'utf8' })
}

/** Add Agent… in that project, a new worktree on hive/held: the dialog says that branch's unused worktree has work in it, and why. */
async function heldWorktree(ctx) {
  const { page, inv } = ctx
  const dir = projectOf(ctx)
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true })
    git(ctx, dir, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    git(ctx, dir, 'add', 'a.txt')
    git(ctx, dir, 'commit', '-qm', 'a')
    git(ctx, dir, 'worktree', 'add', '-q', '-b', 'hive/held', treeOf(ctx), 'main')
    fs.writeFileSync(path.join(treeOf(ctx), 'b.txt'), 'b\n')
    git(ctx, treeOf(ctx), 'add', 'b.txt')
    git(ctx, treeOf(ctx), 'commit', '-qm', 'b')
  }
  await inv('workspace:refresh')
  await inv('project:setActive', dir, true)
  await ctx.command('project.focus', dir)
  await ctx.command('project.tab.session')
  await ctx.command('agent.addWith', dir)
  const dialog = await shown(ctx, page.locator('.dialog[role="dialog"]').last(), 'the Add Agent dialog')
  // Where it works: the project folder, a new worktree, an existing one (the provider's choice, above, is another list).
  const newWorktree = dialog.locator('.choice-list label.choice input[type="radio"]').nth(1)
  if (!(await ctx.lib.until(async () => !(await newWorktree.isDisabled()), ctx.hungMs))) throw new Error('New worktree stayed disabled (no repository?)')
  await newWorktree.check()
  const branch = await shown(ctx, dialog.locator('.agent-form.nested input.input.mono'), "the new worktree's branch")
  await branch.fill('hive/held')
  await shown(ctx, dialog.locator('[data-worktree-match="held"]'), 'the unused worktree with work in it')
  return dialog
}

/** The dialog closed, the project off again (cases after this one count the projects that are on), and alpha shown. */
async function closeHeld(ctx) {
  const { page, lib, inv } = ctx
  if (!(await lib.until(async () => (await page.locator('.dialog[role="dialog"]').count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("the Add Agent dialog didn't close")
  await ctx.command('project.focus', ctx.project)
  await inv('project:setActive', projectOf(ctx), false)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'worktrees',
  screens: [{ name: 'held-worktree', open: heldWorktree, close: closeHeld }]
}
