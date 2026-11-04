// Screenshot cases for the `session` area (#847): what sessions say in the window's language while agents and the
// Agent API read English. An agent compacting by itself (its status, which is Hive's text beside the English
// statusMessage, and the notice), a refused Hand Over (a session HiveError, formatted for the window by IPC) and both in
// the Notifications panel. Reached for the i18nshots route (tests/e2e/i18nshots.cjs has the case format) with
// locale-independent means only: IPC, the fake Claude Code's files, command ids and structural hooks, never English text.
const fs = require('fs')
const path = require('path')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** One's live session, or null. */
const liveOf = async (ctx) => (await ctx.inv('session:live')).find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === ctx.agents[0].id) ?? null

/** Waits until One's session is as `ok` says. */
async function until(ctx, ok, what) {
  if (!(await ctx.lib.until(async () => ok(await liveOf(ctx)), ctx.hungMs))) throw new Error(`${what}: ${JSON.stringify((await liveOf(ctx))?.status ?? null)}`)
}

/** A file in the fake Claude Code's home that it acts on (and removes), for One (its CW_AGENT). */
const fakeFile = (ctx, name) => fs.writeFileSync(path.join(ctx.claudeHome, `${name}-${ctx.agents[0].name}`), '')

/** The toasts gone (each closed, or timed out), and no dialog left open. */
async function noToasts(ctx) {
  const { page, lib } = ctx
  const cancel = () => page.locator('.dialog').last().locator('button.subtle').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("the dialog didn't close")
  const dismiss = () => page.locator('.toasts .toast .icon-btn').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.toasts .toast').count()) === 0 || (await dismiss()), ctx.hungMs))) throw new Error("the notices didn't close")
}

/**
 * One, resumed, compacts its conversation by itself while idle (as Claude Code does before its prompt cache expires): its pane
 * says it is compacting, and a notice says so. Held until close() lets the fake finish.
 */
async function autoCompact(ctx) {
  const { page, inv, project, agents } = ctx
  // In One's latest conversation (the panes case's), so no new one tops the Sessions tab's list for the cases after.
  const last = (await inv('session:list', project)).filter((x) => x.agentId === agents[0].id && x.hasTranscript).sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))[0]
  await inv('session:start', project, { agentId: agents[0].id, ...(last ? { resumeId: last.id } : {}) })
  await until(ctx, (s) => s?.status === 'ready', "One didn't start")
  await ctx.command('project.tab.session')
  fakeFile(ctx, 'fake-idle-compact')
  await until(ctx, (s) => s?.runtime?.maintenance === 'compacting' && !!s.statusText, "One didn't start compacting")
  await shown(ctx, page.locator('.pane-status'), "One's status")
  await shown(ctx, page.locator('.toasts .toast'), 'the notice')
  return null
}

/** The compaction over, the notice closed, One stopped. */
async function closeAutoCompact(ctx) {
  const { inv, project, agents } = ctx
  fakeFile(ctx, 'fake-idle-compact-done')
  await until(ctx, (s) => s?.runtime?.maintenance !== 'compacting', "One didn't finish compacting")
  await noToasts(ctx)
  await inv('session:stop', project, agents[0].id)
  await until(ctx, (s) => !s || s.status === 'stopped' || s.status === 'exited', "One didn't stop")
}

/**
 * Hand Over to… from One (stopped) to Two with the latest handover, when the project has none: Hive refuses
 * (session.handOver.none, a HiveError), and the window says so in a notice in its language.
 */
async function handOverRefused(ctx) {
  const { page, project, agents } = ctx
  await ctx.command('session.handOverTo', project, agents[0].id)
  const go = await shown(ctx, page.locator('.dialog button.primary:not([disabled])'), "the Hand Over dialog's button")
  await go.click()
  return shown(ctx, page.locator('.toasts .toast.error'), 'the refusal')
}

/** The Notifications panel, which keeps both notices. */
async function notifications(ctx) {
  await ctx.command('view.notifications')
  if (!(await ctx.lib.until(async () => (await ctx.page.locator('.notif-panel .notif-item').count()) >= 2, ctx.hungMs))) throw new Error("the panel didn't list the notices")
  return shown(ctx, ctx.page.locator('.notif-panel'), 'the notifications panel')
}

/** The panel closed. */
async function closeNotifications(ctx) {
  await (await shown(ctx, ctx.page.locator('.notif-panel .pane-header .icon-btn').last(), "the panel's close")).click()
  if (!(await ctx.lib.until(async () => (await ctx.page.locator('.notif-panel').count()) === 0, ctx.hungMs))) throw new Error("the panel didn't close")
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'session',
  screens: [
    { name: 'auto-compact', open: autoCompact, close: closeAutoCompact },
    { name: 'hand-over-refused', open: handOverRefused, close: noToasts },
    { name: 'notifications', open: notifications, close: closeNotifications }
  ]
}
