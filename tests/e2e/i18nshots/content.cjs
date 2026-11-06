// Screenshot cases for the `content` area (#849): what main says about the workspace's content, shown in the run's
// language: a Combwork skill whose header is broken (why nobody gets it, in its badge's tip), an MCP server whose definition
// isn't one (why, in the MCP view's list), and a template that can't be loaded yet (the reasons main gives, here an agent
// it would replace running). Reached for the i18nshots route (tests/e2e/i18nshots.cjs has the case format and ctx)
// with locale-independent means only: files in the test workspace, IPC, command ids and structural hooks (classes,
// icons, data-audience), never English text. Each case's close() removes what it added. The area's refusals reach the
// window through IPC, which tests/i18n/content.test.ts checks in another language.
const fs = require('fs')
const path = require('path')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** Waits for a locator to be gone; throws saying what stayed. */
async function gone(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) === 0, ctx.hungMs))) throw new Error(`${what} stayed`)
}

/** An icon button by its icon (its name is translated), within `scope`. */
const iconButton = (ctx, scope, icon) => ctx.page.locator(`${scope} .icon-btn`, { has: ctx.page.locator(`.codicon-${icon}`) }).first()

/** Until `locator` has `n` matches (n > 0: at least one), refreshing the sidebar's view (its header's refresh) between looks. */
const untilRefreshed = (ctx, locator, n) =>
  ctx.lib.until(async () => {
    const count = await locator.count()
    if (n > 0 ? count > 0 : count === 0) return true
    await iconButton(ctx, '.sidebar .pane-header', 'refresh').click({ timeout: 2000 }).catch(() => undefined)
    return false
  }, ctx.hungMs)

/** Shows a sidebar view by its command, unless it is already shown (the command would hide the sidebar then). */
async function showView(ctx, command, hook) {
  if (!(await ctx.page.locator(hook).count())) await ctx.command(command)
}

const skillDir = (ctx) => path.join(ctx.workspace, '.combwork', 'skills', 'broken-header')
const mcpFile = (ctx) => path.join(ctx.workspace, '.combwork', 'mcp', 'not-a-server.json')
const templateFile = (ctx) => path.join(ctx.workspace, '.combwork', 'templates', 'aardvark.json')

/** A Combwork skill whose header names an audience Combwork doesn't know: its Not given badge, hovered, says why in the window's language. */
async function skillProblem(ctx) {
  fs.mkdirSync(skillDir(ctx), { recursive: true })
  fs.writeFileSync(path.join(skillDir(ctx), 'SKILL.md'), '---\nname: broken-header\ndescription: x\nmetadata:\n  audience: everyone\n---\n\n# x\n')
  await showView(ctx, 'view.skills', '.sidebar .skill-row')
  const badge = ctx.page.locator('.sidebar .skill-row [data-audience="none"]')
  // The view reads the skills again on its refresh: until the new one shows.
  if (!(await untilRefreshed(ctx, badge, 1))) throw new Error('the skill with a broken header did not show')
  await badge.first().hover()
  await shown(ctx, ctx.page.locator('.tip'), "the badge's tip")
  return null
}

async function closeSkillProblem(ctx) {
  await ctx.page.mouse.move(0, 0)
  fs.rmSync(skillDir(ctx), { recursive: true, force: true })
  const badge = ctx.page.locator('.sidebar .skill-row [data-audience="none"]')
  if (!(await untilRefreshed(ctx, badge, 0))) throw new Error('the skill with a broken header stayed')
}

/** The MCP view with a server whose definition isn't a JSON object: why, under its name, in the window's language. */
async function mcpError(ctx) {
  fs.mkdirSync(path.dirname(mcpFile(ctx)), { recursive: true })
  fs.writeFileSync(mcpFile(ctx), '[1, 2]\n')
  await ctx.command('view.mcp')
  const row = ctx.page.locator('.sidebar .row.tall', { has: ctx.page.locator('.codicon-error') })
  if (!(await untilRefreshed(ctx, row, 1))) throw new Error("the server that isn't one did not show")
  return row.first()
}

async function closeMcpError(ctx) {
  await ctx.inv('mcp:delete', 'not-a-server')
  const row = ctx.page.locator('.sidebar .row.tall', { has: ctx.page.locator('.codicon-error') })
  if (!(await untilRefreshed(ctx, row, 0))) throw new Error("the server that isn't one stayed")
}

/** Alpha's first agent's live session (undefined: none). */
const liveOne = async (ctx) => (await ctx.inv('session:live')).find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === ctx.agents[0].id)

/**
 * A workspace template for a coding agent this Combwork doesn't know (the view notes it), loaded into the project from the
 * Templates view while the project's first agent runs: it can't be loaded yet, and main says why (HI-2159: since
 * HI-2109 an unknown coding agent no longer stops a load; an agent it would replace running does). Named to sort first
 * in the view.
 */
async function templateBlocked(ctx) {
  await ctx.inv('session:start', ctx.project, { agentId: ctx.agents[0].id })
  if (!(await ctx.lib.until(async () => (await liveOne(ctx))?.status === 'ready', ctx.hungMs))) throw new Error(`One did not start: ${JSON.stringify((await liveOne(ctx))?.status ?? null)}`)
  fs.mkdirSync(path.dirname(templateFile(ctx)), { recursive: true })
  fs.writeFileSync(templateFile(ctx), JSON.stringify({ version: 2, name: 'Aardvark', savedAt: '', layout: 'auto', agents: [{ name: 'Gem', role: 'builder', provider: 'gemini' }] }, null, 2))
  await showView(ctx, 'view.templates', '.sidebar .template-row')
  // The workspace's (Combwork's own are listed first, #1436).
  const rows = ctx.page.locator('.sidebar .template-row[data-scope="workspace"]')
  // Until the new one is there, first by name (its name is the template's, in any language).
  const first = async () => (await rows.count()) > 0 && (await rows.first().getAttribute('aria-label')) === 'Aardvark'
  if (!(await ctx.lib.until(async () => (await first()) || (await iconButton(ctx, '.sidebar .pane-header', 'refresh').click({ timeout: 2000 }).then(() => false, () => false)), ctx.hungMs))) throw new Error('the template did not show')
  await rows.first().click()
  await shown(ctx, ctx.page.locator('.template-detail .template-agents'), 'the template')
  await ctx.page.locator('.template-detail-actions button.primary').first().click()
  await (await shown(ctx, ctx.page.locator('.dialog select'), 'the project to load into')).selectOption(ctx.project)
  await ctx.page.locator('.dialog button.primary').last().click()
  // Its reasons, under the message that it can't be loaded yet (choose's dialog, not the plan's).
  if (!(await ctx.lib.until(async () => (await ctx.page.locator('.dialog').count()) === 1 && (await ctx.page.locator('.dialog .template-plan').count()) === 0 && (await ctx.page.locator('.dialog select').count()) === 0, ctx.hungMs))) throw new Error("the message that it can't be loaded yet did not show")
  return ctx.page.locator('.dialog').last()
}

async function closeTemplateBlocked(ctx) {
  await ctx.page.keyboard.press('Escape')
  await gone(ctx, ctx.page.locator('.dialog'), 'the message')
  fs.rmSync(templateFile(ctx), { force: true })
  await ctx.inv('session:stop', ctx.project, ctx.agents[0].id)
  // One read per check (#868): the session can go between two reads.
  const stopped = async () => {
    const s = await liveOne(ctx)
    return !s || ['stopped', 'exited'].includes(s.status)
  }
  if (!(await ctx.lib.until(stopped, ctx.hungMs))) throw new Error(`One didn't stop: ${JSON.stringify(await liveOne(ctx))}`)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'content',
  screens: [
    { name: 'skill-problem', open: skillProblem, close: closeSkillProblem },
    { name: 'mcp-error', open: mcpError, close: closeMcpError },
    { name: 'template-blocked', open: templateBlocked, close: closeTemplateBlocked }
  ]
}
