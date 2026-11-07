// Screenshot cases for the `connections` area (HI-2708): Edit Server…'s model rows (HI-2682, HI-2684), each with its
// Label, Context size and Output budget and the three hints under the list, reached for the i18nshots route
// (tests/e2e/i18nshots.cjs has the case format) with locale-independent means only: IPC, command ids and structural
// hooks (data-section, data-account, data-edit-server, data-save-server, data-model-limits), never English text.
// A server connection with two models is added over IPC: one with a label and limits that leave little room (its
// warning shown), one with none (the placeholders shown); it is removed again after.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** The connection the screen adds (its id, once added). */
let added = null

async function editServer(ctx) {
  const { inv, page } = ctx
  // No server is asked anything: the editor opens with what is saved, and nothing here reads its models.
  const c = await inv('connections:addServer', { cli: 'claude-code', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', preset: 'ollama', models: [], modelsFrom: 'typed' })
  added = c.id
  await inv('connections:editServer', c.id, {
    models: [
      { id: 'qwen3:8b', as: ['opus', 'sonnet', 'haiku'], label: 'Qwen3 8B', context: 32768, output: 6000 },
      { id: 'devstral:24b' }
    ]
  })
  if (!(await page.locator('.settings').count())) await ctx.command('settings.open')
  await (await shown(ctx, page.locator('.settings-nav [data-section="accounts"]'), "Settings' connections section in its list")).click()
  await (await shown(ctx, page.locator(`[data-account="${c.id}"] [data-edit-server]`), "the server connection's Edit Server button")).click()
  const dialog = await shown(ctx, page.locator('.dialog', { has: page.locator('[data-save-server]') }), 'Edit Server')
  await shown(ctx, dialog.locator('[data-model-limits="qwen3:8b"] [data-limits-tight]'), "the first model's little-room warning")
  await shown(ctx, dialog.locator('[data-model-limits="devstral:24b"]'), "the second model's row")
  return dialog
}

/** Cancelled, the connection removed, and Settings left for the project view, as the next area's screens expect. */
async function closeEditServer(ctx) {
  const { page, lib, inv } = ctx
  // Its footer's Cancel (the model rows above have subtle buttons of their own).
  const cancel = () => page.locator('.dialog').last().locator('.dialog-footer button.subtle').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("Edit Server didn't close")
  if (added) await inv('connections:remove', added, {})
  added = null
  await ctx.command('view.projects')
}

module.exports = {
  area: 'connections',
  screens: [{ name: 'edit-server', open: editServer, close: closeEditServer }]
}
