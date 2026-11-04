// Screenshot cases for the `dialects` area (HI-2444): the Dialects view with a file's texts (inherited ones dimmed, an
// outdated override with no current Default, one text expanded to its layers), a save refused with its reasons, and the
// JSON tab with a text that isn't a dialect file. Reached for the i18nshots route (tests/e2e/i18nshots.cjs has the case
// format) with locale-independent means only: IPC, command ids and structural hooks (data-dialect, data-area,
// data-text, data-dialect-* attributes), never English text.
const fs = require('fs')
const path = require('path')

const COPY = 'claude-code/Shots copy.json'

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** The test copy shown, its contract area open and its first line expanded. */
async function openCopy(ctx) {
  const { page } = ctx
  const dir = path.join(ctx.workspace, '.combwork', 'dialects', 'claude-code')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(ctx.workspace, '.combwork', 'dialects', ...COPY.split('/')), JSON.stringify({ name: 'Shots copy', texts: { 'gone.text': { text: 'old', why: 'shots' }, 'contract.agent.folder': { text: 'Mine', why: 'shots' } } }, null, 2))
  await ctx.command('view.dialects')
  await (await shown(ctx, page.locator(`.dialect-row[data-dialect="${COPY}"]`), 'the test copy in the Dialects view')).click()
  const pane = await shown(ctx, page.locator(`.dialect-detail[data-dialect-file="${COPY}"]`), "the test copy's page")
  await (await shown(ctx, pane.locator('.dialect-area[data-area="contract"] .dialect-area-head'), 'the contract area')).click()
  await (await shown(ctx, pane.locator('.dialect-text[data-text-id="contract.agent.host"] .dialect-text-head'), "the contract's first line")).click()
  await shown(ctx, pane.locator('.dialect-text.expanded [data-layers]'), "the text's layers")
  return pane
}

/** Back to the projects, the test copy's draft dropped and the file gone. */
async function close(ctx) {
  const { page } = ctx
  const discard = page.locator('[data-dialect-discard]')
  if (await discard.count()) await discard.first().click()
  await ctx.command('view.projects')
  fs.rmSync(path.join(ctx.workspace, '.combwork', 'dialects', ...COPY.split('/')), { force: true })
}

module.exports = {
  area: 'dialects',
  screens: [
    {
      name: 'view',
      async open(ctx) {
        await openCopy(ctx)
        return null
      },
      close
    },
    {
      name: 'refused',
      async open(ctx) {
        const pane = await openCopy(ctx)
        const row = pane.locator('.dialect-text[data-text-id="contract.agent.host"]')
        await (await shown(ctx, row.locator('[data-dialect-override]'), 'Change Here')).click()
        await (await shown(ctx, row.locator('[data-dialect-edit-text]'), "the override's text")).fill('MINE {project}')
        await pane.locator('[data-dialect-save]').click()
        await shown(ctx, pane.locator('[data-dialect-refused]'), 'the refused save')
        return pane
      },
      close
    },
    {
      name: 'json',
      async open(ctx) {
        const { app, page } = ctx
        const pane = await openCopy(ctx)
        await pane.locator('[data-dialect-tab="json"]').click()
        const editor = await shown(ctx, pane.locator('.dialect-json .monaco-editor .view-lines'), 'the JSON tab')
        await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), '{ "name": "Shots copy", "texts": {')
        await editor.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Control+V')
        await shown(ctx, pane.locator('[data-dialect-json-bad]'), 'the JSON tab saying it is not a dialect file')
        return pane
      },
      async close(ctx) {
        const pane = ctx.page.locator('.dialect-detail')
        const texts = pane.locator('[data-dialect-tab="texts"]')
        if (await texts.count()) {
          await texts.first().click()
          // Leaving the JSON tab with text that isn't a dialect file asks first: drop it.
          const drop = ctx.page.locator('.dialog .btn.danger')
          if (await ctx.lib.until(async () => (await drop.count()) > 0, ctx.hungMs)) await drop.last().click()
        }
        await close(ctx)
      }
    }
  ]
}
