// Screenshot cases for the `providers` area (#797): the provider adapters' user text, reached for the i18nshots route
// (tests/e2e/i18nshots.cjs has the case format) with locale-independent means only: IPC, command ids and structural
// hooks, never English text. Codex and GitHub Copilot are turned on for these screens (and off again after): their CLIs
// are looked for with the test copy's empty homes (lib.cjs gives every test Combwork its own), so Provider Setup shows their
// readiness (not installed, or not signed in, or the sandbox to set up), whatever this machine has.
const fs = require('fs')
const path = require('path')

const WINDOW = { width: 1400, height: 860 }
const TALL = 1600

const setProviders = (ctx, on) => ctx.inv('settings:update', { providers: { codex: { enabled: on }, copilot: { enabled: on } } })

/** Provider Setup with Codex's readiness (its tab): what it needs, with its button. */
async function agentSetup(ctx) {
  const { inv, lib, page, app } = ctx
  await setProviders(ctx, true)
  await inv('provider:refresh')
  const ready = async () => {
    const all = await inv('provider:info')
    return ['codex', 'copilot'].every((id) => all[id] && !all[id].checking && (all[id].readiness ?? []).length > 0)
  }
  if (!(await lib.until(ready, ctx.hungMs))) throw new Error("Codex's and Copilot's readiness did not come")
  await lib.fitWindow(app, page, { width: WINDOW.width, height: TALL })
  return setupTab(ctx, 'codex', 1)
}

/**
 * Provider Setup on a provider's tab, as its command opens it with the provider's id; `n` is the tab's place in Combwork's
 * order (Claude Code, Codex, GitHub Copilot), checked selected.
 */
async function setupTab(ctx, id, n) {
  await ctx.command('help.agentSetup', id)
  const tab = ctx.page.locator('.dialog .setup-tab').nth(n)
  if (!(await ctx.lib.until(async () => /\bselected\b/.test((await tab.getAttribute('class').catch(() => null)) ?? ''), ctx.hungMs))) throw new Error(`Provider Setup's ${id} tab was not selected`)
  return ctx.page.locator('.dialog').last()
}

async function closeSetup(ctx) {
  const { page, lib, app } = ctx
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("Provider Setup didn't close")
  await lib.fitWindow(app, page, WINDOW)
}

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

async function closeToasts(ctx) {
  const { page, lib } = ctx
  const dismiss = () => page.locator('.toasts .toast .icon-btn').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.toasts .toast').count()) === 0 || (await dismiss()), ctx.hungMs))) throw new Error("the notices didn't close")
}

/** The live session of alpha's first agent. */
const firstLive = async (ctx) => (await ctx.inv('session:live')).find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === ctx.agents[0].id)

/** An agent starts in a folder with a stray .codex (an agent's scratch in it), Codex on: the warning that it stops Codex. */
async function strayCodex(ctx) {
  const { inv, lib, page } = ctx
  const codex = path.join(ctx.project, '.codex')
  fs.mkdirSync(codex, { recursive: true })
  fs.writeFileSync(path.join(codex, 'scratch.log'), 'an agent left this\n')
  await closeToasts(ctx)
  await inv('session:start', ctx.project, { agentId: ctx.agents[0].id })
  // The warning is the notice naming the folder (its path is the same in every language).
  let at = -1
  const found = async () => (at = await page.locator('.toasts .toast').evaluateAll((els, p) => els.findIndex((e) => e.innerText.includes(p)), codex)) >= 0
  if (!(await lib.until(found, ctx.hungMs))) throw new Error('the stray .codex warning did not show')
  return page.locator('.toasts .toast').nth(at)
}

async function closeStray(ctx) {
  const { inv, lib, project, agents } = ctx
  await closeToasts(ctx)
  // A turn first, so the session it started has a transcript, as the others listed after it do (the sessions case opens
  // the newest).
  if (!(await lib.until(async () => (await firstLive(ctx))?.status === 'ready', ctx.hungMs))) throw new Error('the agent did not start')
  const prompt = lib.fakePrompts(inv, lib.ptyKey(project, agents[0].id), () => firstLive(ctx), { home: ctx.claudeHome })
  if (!(await prompt.over(await prompt.type('hello')))) throw new Error("the agent's turn did not end")
  await inv('session:stop', project, agents[0].id)
  if (!(await lib.until(async () => {
    const s = await firstLive(ctx)
    return !s || s.status === 'stopped' || s.status === 'exited'
  }, ctx.hungMs)))
    throw new Error("the agent didn't stop")
  fs.rmSync(path.join(project, '.codex'), { recursive: true, force: true })
  await setProviders(ctx, false)
}

/**
 * A start refused at its launch (#842): alpha's Claude Code agents get a --settings with no value, so the window's New
 * Session fails with main's HiveError, in the run's language.
 */
async function launchRefused(ctx) {
  const { inv, page } = ctx
  await closeToasts(ctx)
  await ctx.lib.setProjectLaunch(inv, ctx.project, 'claude-code', { extraArgs: '--settings' })
  await ctx.command('project.focus', ctx.project)
  await ctx.command('project.tab.session')
  await ctx.command('session.new')
  return shown(ctx, page.locator('.toasts .toast.error'), 'the refused start')
}

/** Its notice closed and the extra arguments taken off again. */
async function closeLaunchRefused(ctx) {
  await closeToasts(ctx)
  await ctx.lib.setProjectLaunch(ctx.inv, ctx.project, 'claude-code', { extraArgs: '' })
}

module.exports = {
  area: 'providers',
  screens: [
    { name: 'agent-setup-codex', open: agentSetup },
    { name: 'agent-setup-copilot', open: (ctx) => setupTab(ctx, 'copilot', 2), close: closeSetup },
    { name: 'stray-codex', open: strayCodex, close: closeStray },
    { name: 'launch-refused', open: launchRefused, close: closeLaunchRefused }
  ]
}
