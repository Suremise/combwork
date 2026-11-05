// Screenshot cases for the `settings` area (#793): every section of Settings, Advanced's list with its notes, the
// shortcut recorder, a number setting's range message and Settings' confirmations, reached for the i18nshots route
// (tests/e2e/i18nshots.cjs has the case format) with locale-independent means only: IPC, command ids and structural
// hooks (data-section, data-setting, data-action, data-advanced, classes), never English text.
const fs = require('fs')
const path = require('path')

/** The window's size the route photographs in (lib.fitWindow), and the tallest a section is photographed at. */
const WINDOW = { width: 1400, height: 860 }
const TALLEST = 4000

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** Settings, on one section: settings.open toggles the view, so it is run only when Settings isn't shown. */
async function openSection(ctx, id) {
  const { page } = ctx
  if (!(await page.locator('.settings').count())) await ctx.command('settings.open')
  await (await shown(ctx, page.locator(`.settings-nav [data-section="${id}"]`), `Settings' ${id} section in its list`)).click()
  return shown(ctx, page.locator(`.settings-group[data-section="${id}"]`), `Settings' ${id} section`)
}

/** The window made tall enough to show all of Settings' content (up to TALLEST), so one photograph has every row. */
async function showAll(ctx) {
  const { page, app, lib } = ctx
  const extra = await page.evaluate(() => {
    const c = document.querySelector('.settings-content')
    return c ? c.scrollHeight - c.clientHeight : 0
  })
  if (extra > 0) await lib.fitWindow(app, page, { width: WINDOW.width, height: Math.min(TALLEST, WINDOW.height + extra) })
  // Laid out at that size: the content no longer scrolls (or is as tall as it can be).
  await lib.until(async () => page.evaluate((most) => {
    const c = document.querySelector('.settings-content')
    return !!c && (c.scrollHeight <= c.clientHeight + 1 || window.innerHeight >= most)
  }, TALLEST), ctx.hungMs)
  return page.locator('.settings-content').first()
}

const restoreWindow = (ctx) => ctx.lib.fitWindow(ctx.app, ctx.page, WINDOW)

/** Its Cancel (a dialog's first subtle button), until no dialog is open. */
async function cancelDialog(ctx) {
  const { page, lib } = ctx
  const cancel = () => page.locator('.dialog').last().locator('button.subtle').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("the dialog didn't close")
}

/** Settings' sections, in their order (settingsCatalog.ts SETTINGS_SECTIONS), each photographed whole. */
const SECTIONS = ['general', 'updates', 'appearance', 'providers', 'provider:claude-code', 'provider:codex', 'provider:copilot', 'accounts', 'notifications', 'sessions', 'assistant', 'workspace', 'board', 'workflow', 'agents', 'keybindings', 'mcpCatalogs', 'agentApi', 'advanced']
const screenName = (id) => `section-${id.replace(/:/g, '-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

const sectionScreens = SECTIONS.map((id) => ({
  name: screenName(id),
  open: async (ctx) => {
    await openSection(ctx, id)
    return showAll(ctx)
  },
  close: restoreWindow
}))

/** advanced.json in the test copy's profile. */
async function advancedFile(ctx) {
  return path.join((await ctx.inv('app:info')).userData, 'advanced.json')
}

/** Shows one of Advanced's tabs (HI-1839: Combwork, then each CLI), by its group's id, whatever the language. */
async function advancedTab(ctx, group) {
  const tab = ctx.page.locator(`.advanced-tabs [role="tab"][data-tab="${group}"]`)
  await tab.click()
  if (!(await ctx.lib.until(async () => (await tab.getAttribute('aria-selected')) === 'true', ctx.hungMs))) throw new Error(`Advanced's ${group} tab wasn't shown`)
}

/**
 * Advanced's list with what it says about values: one that isn't valid (below its range), one that no longer finds
 * what the CLI was recorded showing, an id this Combwork doesn't know, and each one's default beside it. Modified only.
 */
async function advancedNotes(ctx) {
  const { page } = ctx
  fs.writeFileSync(await advancedFile(ctx), `${JSON.stringify({ format: 1, values: { 'cw.mcp.replySeconds': 5, 'codex.ready.placeholder': 'zzz nothing like it', 'hive.not.a.value': 1 }, madeFor: {} }, null, 2)}\n`)
  await openSection(ctx, 'advanced')
  await advancedTab(ctx, 'hive')
  await shown(ctx, page.locator('.advanced-row.invalid[data-advanced="cw.mcp.replySeconds"]'), 'the value that is not valid')
  await advancedTab(ctx, 'codex')
  await shown(ctx, page.locator('[data-advanced="codex.ready.placeholder"] .advanced-note.warn'), "the value that doesn't find the recorded text")
  const modifiedOnly = page.locator('.settings-top input.checkbox').first()
  if (!(await modifiedOnly.isChecked())) await modifiedOnly.click()
  await shown(ctx, page.locator('.settings-group[data-section="advanced"] .advanced-list'), "Advanced's list, modified only")
  return showAll(ctx)
}

async function closeAdvancedNotes(ctx) {
  const { page, lib } = ctx
  const modifiedOnly = page.locator('.settings-top input.checkbox').first()
  if (await modifiedOnly.isChecked()) await modifiedOnly.click()
  fs.writeFileSync(await advancedFile(ctx), `${JSON.stringify({ format: 1, values: {}, madeFor: {} }, null, 2)}\n`)
  if (!(await lib.until(async () => (await page.locator('.advanced-row.invalid').count()) === 0, ctx.hungMs))) throw new Error("advanced.json's values didn't go")
  await restoreWindow(ctx)
}

/** A value typed into Advanced's list that isn't taken (a field name starting with a digit): its refusal under it. */
async function advancedTyped(ctx) {
  const { page } = ctx
  await openSection(ctx, 'advanced')
  await advancedTab(ctx, 'codex')
  const row = await shown(ctx, page.locator('[data-advanced="codex.rateLimits.field"]'), "Codex's plan limits field")
  const box = row.locator('.advanced-control input.input').first()
  await box.fill('0bad')
  await box.press('Enter')
  await shown(ctx, row.locator('.field-error'), 'the refusal under the box')
  return row
}

/** Nothing was saved: the value stays its default, and the next screen finds Settings on its first section. */
async function closeAdvancedTyped(ctx) {
  const state = await ctx.inv('advanced:state')
  if (state?.values?.['codex.rateLimits.field'] !== undefined) throw new Error('the refused value was saved')
  // The next screens find Advanced on Combwork's tab again.
  await advancedTab(ctx, 'hive')
  await openSection(ctx, 'general')
}

/** Recording a shortcut: the recorder's prompt in the first command's row. */
async function shortcutRecording(ctx) {
  const { page } = ctx
  await openSection(ctx, 'keybindings')
  await (await shown(ctx, page.locator('.kb-table [data-action="edit-shortcut"]'), "a command's Change shortcut button")).click()
  await shown(ctx, page.locator('.kbd-recorder'), 'the shortcut recorder')
  // Its row, not the whole editor (every command: thousands of pixels tall).
  return shown(ctx, page.locator('.kb-table tr.recording'), "the recording command's row")
}

async function stopRecording(ctx) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator('.kbd-recorder').count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("the recorder didn't close")
}

/** A number setting given a value out of its range: the range under its box. */
async function numberOutOfRange(ctx) {
  const { page } = ctx
  await openSection(ctx, 'sessions')
  const row = await shown(ctx, page.locator('[data-setting="sessions.usageCacheSize"]'), 'the usage cache size row')
  const box = row.locator('input.input').first()
  await box.fill('5')
  await box.press('Enter')
  await shown(ctx, row.locator('.field-error'), "the box's range message")
  return row
}

/** Its own value again, so the next screen finds Settings as it was. */
async function closeNumber(ctx) {
  const { page, lib } = ctx
  const row = page.locator('[data-setting="sessions.usageCacheSize"]').first()
  const value = String((await ctx.inv('settings:get')).sessions.usageCacheSize)
  const box = row.locator('input.input').first()
  await box.fill(value)
  await box.press('Enter')
  if (!(await lib.until(async () => (await row.locator('.field-error').count()) === 0, ctx.hungMs))) throw new Error("the range message didn't go")
}

/** A confirmation Settings asks, by the button that opens it. */
const confirmation = (section, opener, what) => async (ctx) => {
  await openSection(ctx, section)
  await (await shown(ctx, ctx.page.locator(opener), what)).click()
  return shown(ctx, ctx.page.locator('.dialog').last(), `the confirmation after ${what}`)
}

module.exports = {
  area: 'settings',
  screens: [
    ...sectionScreens,
    { name: 'advanced-notes', open: advancedNotes, close: closeAdvancedNotes },
    { name: 'advanced-typed-invalid', open: advancedTyped, close: closeAdvancedTyped },
    { name: 'shortcut-recording', open: shortcutRecording, close: stopRecording },
    { name: 'number-out-of-range', open: numberOutOfRange, close: closeNumber },
    { name: 'confirm-reset-all', open: confirmation('advanced', '[data-action="reset-all"]', 'Reset all settings'), close: cancelDialog },
    { name: 'confirm-regenerate-token', open: confirmation('agentApi', '[data-action="regenerate-token"]', "the Agent API token's Regenerate"), close: cancelDialog },
    {
      name: 'confirm-dangerous-mode',
      open: confirmation('provider:claude-code', '[data-setting="claude-code.enableDangerousMode"] .switch', "Claude Code's dangerous mode switch"),
      // Cancelled, then Settings left for the project view, as the next area's screens expect.
      close: async (ctx) => {
        await cancelDialog(ctx)
        await ctx.command('view.projects')
      }
    }
  ]
}
